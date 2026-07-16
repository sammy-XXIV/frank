import { OKXFacilitatorClient } from "@okxweb3/app-x402-core";
import { x402ResourceServer } from "@okxweb3/app-x402-core/server";
import { AggrDeferredEvmScheme } from "@okxweb3/app-x402-evm/deferred/server";
import { ExactEvmScheme } from "@okxweb3/app-x402-evm/exact/server";
import type express from "express";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

export const NETWORK = (process.env.X402_NETWORK ?? "eip155:196") as `eip155:${string}`;
export const PAY_TO = requireEnv("PAY_TO_ADDRESS");
// X Layer's USD₮0 (6 decimals) — same settlement asset as before the scheme swap.
const ASSET = process.env.X402_ASSET ?? "0x779ded0c9e1022225f8e0630b35a9b54be713736";

/**
 * Per-call prices in base units (6-decimal stablecoin), marketplace-compliant
 * "exact" scheme — a fixed price per request, settled on-chain per call.
 * Margins vs. real Claude cost per call (~$0.005-0.02 depending on mode):
 * qa/event ~$0.05 → ~75-90%; dispute $0.10 (longest prompts/output) → ~80%.
 * onboard/learn make no LLM call — priced at $0.01 so every request still
 * carries a signed payer identity (that's what keys the knowledge store).
 */
export const PRICE_BASE_UNITS = {
  qa: process.env.FRANK_PRICE_QA ?? "50000", // $0.05
  dispute: process.env.FRANK_PRICE_DISPUTE ?? "100000", // $0.10
  event: process.env.FRANK_PRICE_EVENT ?? "50000", // $0.05
  onboard: process.env.FRANK_PRICE_ONBOARD ?? "10000", // $0.01
  learn: process.env.FRANK_PRICE_LEARN ?? "10000", // $0.01
} as const;

export function exactAccept(amountBaseUnits: string) {
  return {
    scheme: "exact" as const,
    network: NETWORK,
    payTo: PAY_TO,
    price: { amount: amountBaseUnits, asset: ASSET },
    // USD₮0's EIP-712 domain — buyers signing transferWithAuthorization need
    // this; copied from Fit Check's live, validated 402 for the same asset.
    extra: { name: "USD₮0", version: "1" },
  };
}

/**
 * Second accepted method: aggr_deferred ("batch"). Same per-call price; the
 * buyer signs with an Agentic Wallet session key and OKX's facilitator batches
 * settlements on-chain asynchronously. Seller-side handling is identical to
 * exact (verify → deliver); the sessionCert lives in the buyer's payload and
 * is forwarded verbatim — it must NOT appear here in the requirements.
 */
export function aggrDeferredAccept(amountBaseUnits: string) {
  return {
    scheme: "aggr_deferred" as const,
    network: NETWORK,
    payTo: PAY_TO,
    price: { amount: amountBaseUnits, asset: ASSET },
    extra: { name: "USD₮0", version: "1" },
  };
}

/** Both accepted payment options for a route, exact first (recommended default). */
export function acceptsFor(amountBaseUnits: string) {
  return [exactAccept(amountBaseUnits), aggrDeferredAccept(amountBaseUnits)];
}

const facilitatorOptions = {
  apiKey: requireEnv("OKX_API_KEY"),
  secretKey: requireEnv("OKX_SECRET_KEY"),
  passphrase: requireEnv("OKX_PASSPHRASE"),
  // Key genuinely omitted (not set to undefined) when unset — this SDK version's
  // "omit -> production default" only triggers on a truly absent key.
  ...(process.env.OKX_BASE_URL ? { baseUrl: process.env.OKX_BASE_URL } : {}),
};
const facilitator = new OKXFacilitatorClient(facilitatorOptions);

export const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactEvmScheme())
  .register(NETWORK, new AggrDeferredEvmScheme());

/** Call once at startup, before serving requests. */
export async function initPayments(): Promise<void> {
  await resourceServer.initialize();
}

/**
 * Payer identity for the knowledge store. The express middleware's exact-scheme
 * path doesn't attach payment context to `req` (verified against the installed
 * dist — only the subscription paths set req.x402), so we read it from the
 * PAYMENT-SIGNATURE header the middleware already verified: the EIP-3009
 * authorization's `from` is the paying wallet.
 */
export function payerOf(req: express.Request): string {
  const header = req.header("payment-signature");
  if (!header) throw new Error("no verified payment on request");
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    payload?: { authorization?: { from?: string } };
  };
  const from = payload?.payload?.authorization?.from;
  if (!from) throw new Error("payment payload missing payer");
  return from.toLowerCase();
}
