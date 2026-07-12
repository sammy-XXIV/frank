import type { PlanCatalogEntry } from "@okxweb3/app-x402-core/subscription";
import { OKXFacilitatorClient } from "@okxweb3/app-x402-core";
import { x402ResourceServer } from "@okxweb3/app-x402-core/server";
import { InMemoryStore, SubscriptionClient } from "@okxweb3/app-x402-core/subscription";
import { PermitSubscriptionScheme } from "@okxweb3/app-x402-evm/subscription";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

export const NETWORK = (process.env.X402_NETWORK ?? "eip155:196") as `eip155:${string}`;
const PAY_TO = requireEnv("PAY_TO_ADDRESS");
// X Layer's official settlement stablecoin (USD₮0) — same asset address Fit Check's
// own 402 response used. Set explicitly; the SDK's "omit -> default" convenience
// wants a concrete string in this version's types, not undefined.
const DEFAULT_ASSET = process.env.X402_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736";

// Single plan for v1: one tier, monthly, covers all three modes (qa/dispute/event).
// Multi-tier (Basic/Pro) is a real feature the SDK supports but not needed yet.
export const serverPlan: PlanCatalogEntry = {
  id: "frank_server_monthly",
  tier: 1,
  payTo: PAY_TO,
  asset: DEFAULT_ASSET,
  amountPerPeriod: process.env.FRANK_PRICE_BASE_UNITS ?? "5000000", // 6-decimal stablecoin; "5000000" = $5.00/month
  periodSec: 2_592_000, // 30 days
  periodMode: 0, // fixed interval
  maxPeriods: 12,
  initialCharge: {
    periodCount: 1,
    totalAmount: process.env.FRANK_PRICE_BASE_UNITS ?? "5000000",
  },
  name: "Frank — Server Plan",
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

// TODO before real launch: swap InMemoryStore for a persistent store (Postgres/Redis) —
// subscription state must survive a restart, an in-memory store loses it.
export const store = new InMemoryStore();
export const scheme = new PermitSubscriptionScheme({ facilitator, network: NETWORK, store });
export const subscriptionClient = new SubscriptionClient({ scheme, store });

export const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, scheme);

/** Call once at startup, before serving requests. */
export async function initPayments(): Promise<void> {
  await resourceServer.initialize();
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
