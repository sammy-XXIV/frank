import type { OnBeforeAccessHook, PlanCatalogEntry } from "@okxweb3/app-x402-core/subscription";
import { OKXFacilitatorClient } from "@okxweb3/app-x402-core";
import { x402ResourceServer } from "@okxweb3/app-x402-core/server";
import { SubscriptionClient } from "@okxweb3/app-x402-core/subscription";
import { FileSubscriptionStore, PersistentMap } from "./persist.js";
import { PermitSubscriptionScheme } from "@okxweb3/app-x402-evm/subscription";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

export const NETWORK = (process.env.X402_NETWORK ?? "eip155:196") as `eip155:${string}`;
const PAY_TO = requireEnv("PAY_TO_ADDRESS");
// USDT0 — per OKX's A2MCP guide, "official settlement stablecoin on X Layer".
// This SDK version (0.2.0) requires an explicit asset (parsePrice rejects
// Money strings and enhancePaymentRequirements fills no default, despite what
// the newer docs say about omission).
const DEFAULT_ASSET = process.env.X402_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736";

// Single plan for v1: one tier, monthly, covers all three modes (qa/dispute/event).
// Multi-tier (Basic/Pro) is a real feature the SDK supports but not needed yet.
//
// Price is cost-based, not a guess: Claude Sonnet 5 is $3/$15 per MTok in/out
// (standard rate — the $2/$10 intro pricing expires 2026-08-31, so margin is
// computed off the durable rate). A call here runs ~500-3000 input tokens
// (docs-grounded system prompt) + ~200-800 output tokens, i.e. ~$0.0045-$0.021
// per call depending on mode and docs size. At the MONTHLY_CALL_QUOTA cap
// (see quotaGuard below), worst-case cost is ~$6.60/mo, typical is ~$3.30/mo —
// $14.99/mo leaves ~56% margin worst-case, ~78% typical.
const DEFAULT_PRICE_BASE_UNITS = "14990000"; // 6-decimal stablecoin; $14.99/month
export const serverPlan: PlanCatalogEntry = {
  id: "frank_server_monthly",
  tier: 1,
  payTo: PAY_TO,
  asset: DEFAULT_ASSET,
  amountPerPeriod: process.env.FRANK_PRICE_BASE_UNITS ?? DEFAULT_PRICE_BASE_UNITS,
  periodSec: 2_592_000, // 30 days
  periodMode: 0, // fixed interval
  maxPeriods: 12,
  initialCharge: {
    periodCount: 1,
    totalAmount: process.env.FRANK_PRICE_BASE_UNITS ?? DEFAULT_PRICE_BASE_UNITS,
  },
  name: "Frank Server Plan", // ASCII only: a non-ASCII char here broke requirement matching (build pipeline mangled it)
};

// Usage cap so a single heavy server can't cost more in API calls than the flat
// subscription covers. Only /qa, /dispute, /event count (they're the only routes
// that call Claude) — /onboard and /subscription/cancel are free. Keyed by
// subId + lastChargedPeriod, so the counter resets itself every billing period
// with no separate cron needed.
const MONTHLY_CALL_QUOTA = Number(process.env.FRANK_MONTHLY_CALL_QUOTA ?? "300");

// Persisted to the data volume — quota survives restarts/redeploys.
const callCounts = new PersistentMap<{ period: number; count: number }>("quota");

export const quotaGuard: OnBeforeAccessHook = async (ctx) => {
  const { subId, lastChargedPeriod, nextChargeableAt } = ctx.subscription;
  const prior = callCounts.get(subId);
  const count = prior && prior.period === lastChargedPeriod ? prior.count : 0;

  if (count >= MONTHLY_CALL_QUOTA) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      ok: false,
      error: `Monthly usage limit reached (${MONTHLY_CALL_QUOTA} calls). Resets next billing period.`,
      retryAfter: nextChargeableAt != null ? Math.max(0, nextChargeableAt - nowSec) : undefined,
    };
  }

  callCounts.set(subId, { period: lastChargedPeriod, count: count + 1 });
  return { ok: true };
};

export function toAccept(plan: PlanCatalogEntry) {
  const asset = plan.asset ?? DEFAULT_ASSET;
  return {
    scheme: "period" as const,
    network: NETWORK,
    payTo: plan.payTo,
    asset,
    price: { amount: plan.amountPerPeriod, asset },
    maxTimeoutSeconds: 600,
    extra: {
      amountPerPeriod: plan.amountPerPeriod,
      periodMode: plan.periodMode ?? 0,
      periodSec: plan.periodSec,
      maxPeriods: plan.maxPeriods,
      initialCharge: plan.initialCharge,
      plan: { id: plan.id, tier: plan.tier, name: plan.name },
    },
  };
}

const facilitatorOptions = {
  apiKey: requireEnv("OKX_API_KEY"),
  secretKey: requireEnv("OKX_SECRET_KEY"),
  passphrase: requireEnv("OKX_PASSPHRASE"),
  // Key genuinely omitted (not set to undefined) when unset — this SDK version's
  // "omit -> production default" only triggers on a truly absent key, not an
  // explicit `undefined` value.
  ...(process.env.OKX_BASE_URL ? { baseUrl: process.env.OKX_BASE_URL } : {}),
};
const facilitator = new OKXFacilitatorClient(facilitatorOptions);

// TEMP DEBUG: log full facilitator envelopes for subscribe — the SDK surfaces
// only envelope.msg ("unknown error") and drops the code + details we need to
// diagnose settle rejections. Remove once the first real subscribe succeeds.
{
  const raw = facilitator.subscribe.bind(facilitator);
  (facilitator as { subscribe: typeof raw }).subscribe = async (...args: Parameters<typeof raw>) => {
    try {
      const envelope = await raw(...args);
      console.error("FACILITATOR subscribe envelope:", JSON.stringify(envelope));
      return envelope;
    } catch (err) {
      console.error("FACILITATOR subscribe threw:", err);
      throw err;
    }
  };
}

// File-backed on the data volume — subscriptions survive restarts/redeploys.
// The facilitator-rehydration wrapper below remains as a second safety net.
export const store = new FileSubscriptionStore();
export const scheme = new PermitSubscriptionScheme({ facilitator, network: NETWORK, store });

// Restart resilience: after a reboot the InMemoryStore is empty, and the SDK's
// verifyAccess short-circuits to "subscription_not_active" without consulting
// the facilitator when the row is missing. Rehydrate from the facilitator
// (authoritative) on a store miss, then re-verify — so active subscribers
// survive our redeploys even before we add a persistent store.
{
  const rawVerifyAccess = scheme.verifyAccess.bind(scheme);
  scheme.verifyAccess = async (proof, route) => {
    const missing = !(await store.get(proof.subId));
    if (missing) {
      try {
        const sub = await scheme.getSubscription(proof.subId);
        if (sub) await store.put(sub);
      } catch (err) {
        console.error(`store rehydration failed for ${proof.subId}:`, err);
      }
    }
    return rawVerifyAccess(proof, route);
  };
}
export const subscriptionClient = new SubscriptionClient({ scheme, store });

export const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, scheme);

// TEMP DEBUG: log matcher inputs whenever requirement matching fails, so we can
// see exactly which field the server thinks differs. Remove with other debug.
{
  const rs = resourceServer as unknown as {
    findMatchingRequirements: (avail: unknown[], payload: { accepted?: unknown }) => unknown;
  };
  const rawMatch = rs.findMatchingRequirements.bind(resourceServer);
  rs.findMatchingRequirements = (avail, payload) => {
    const result = rawMatch(avail, payload);
    if (!result) {
      console.error("MATCH FAIL server:", JSON.stringify(avail));
      console.error("MATCH FAIL buyer :", JSON.stringify(payload?.accepted));
    }
    return result;
  };
}

/** Call once at startup, before serving requests. */
export async function initPayments(): Promise<void> {
  await resourceServer.initialize();
  // TEMP DEBUG: dump the facilitator's /supported so we can see which asset(s)
  // the subscription scheme actually settles in on this network.
  try {
    const supported = await facilitator.getSupported();
    console.error("FACILITATOR /supported:", JSON.stringify(supported));
  } catch (err) {
    console.error("FACILITATOR /supported failed:", err);
  }
}

/**
 * Scheduled charge loop — subscriptions don't renew themselves, the seller backend
 * has to actively trigger each period's charge. Missed periods aren't backfilled,
 * so this needs to run reliably for as long as Frank is live.
 */
export function startChargeLoop(intervalMs = 60_000): NodeJS.Timeout {
  const nowSec = () => Math.floor(Date.now() / 1000);
  return setInterval(async () => {
    const subs = await store.list();
    for (const sub of subs) {
      if (sub.state !== "active") continue;
      if (sub.nextChargeableAt == null) continue;
      if (sub.nextChargeableAt > nowSec()) continue;
      try {
        await subscriptionClient.charge(sub.subId);
      } catch (err) {
        console.error(`charge failed for sub ${sub.subId}:`, err);
        // TODO before real launch: dunning — retry with backoff, notify the server
        // owner, auto-suspend Frank's moderation for that server after N failures.
      }
    }
  }, intervalMs);
}
