/**
 * One-time subscribe flow — turns a funded wallet into an active Frank
 * subscription. Run once per buyer:
 *
 *   npm run subscribe -- "Project Name" ./docs.md
 *
 * Flow (all shapes verified against the installed @okxweb3 SDK dist):
 *   1. POST /onboard unpaid → 402 + PAYMENT-REQUIRED header → pick "period" offer
 *   2. Ensure ERC20 allowance token→Permit2 (one on-chain approve if missing — needs OKB gas)
 *   3. Read current Permit2 nonce for (payer, token, subscription contract)
 *   4. Sign PermitSingle (EIP-712) + SubscriptionTerms (EIP-712, bound via permitHash)
 *   5. POST /onboard again with APP-PAYMENT header + docs body
 *      → facilitator settles first charge on-chain → handler stores docs
 *   6. PAYMENT-RESPONSE header carries { subId, txHash } → prints FRANK_SUB_ID
 *
 * Env: FRANK_URL, PAYER_PRIVATE_KEY, optional XLAYER_RPC_URL
 */
import fs from "node:fs";
import crypto from "node:crypto";
import {
  buildPermit2TypedData,
  buildSubscriptionTermsTypedData,
  computePermitSingleStructHash,
  encodePaymentPayload,
  parsePaymentRequired,
  type PermitSingleData,
  type SubscriptionRequirementsExtra,
} from "@okxweb3/app-x402-core/subscription";
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayer } from "viem/chains";

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
}

const FRANK_URL = requireEnv("FRANK_URL");
const account = privateKeyToAccount(requireEnv("PAYER_PRIVATE_KEY") as `0x${string}`);
const RPC = process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";

const projectName = process.argv[2] ?? "Demo Project";
const docsPath = process.argv[3];
const docs = docsPath
  ? fs.readFileSync(docsPath, "utf8")
  : "RULES:\n1. Be respectful.\nFAQ:\n- This is placeholder onboarding; run /setup in Discord to replace it.";

const publicClient = createPublicClient({ chain: xLayer, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: xLayer, transport: http(RPC) });

// Permit2 AllowanceTransfer.allowance(owner, token, spender) → (amount, expiration, nonce)
const PERMIT2_ALLOWANCE_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

async function main() {
  console.log(`Payer: ${account.address}`);
  console.log(`Frank: ${FRANK_URL}`);

  // 1. Provoke the 402 to get the offer
  const challenge = await fetch(`${FRANK_URL}/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectName, docs }),
  });
  if (challenge.status !== 402) {
    throw new Error(`expected 402 challenge, got ${challenge.status}`);
  }
  const prHeader = challenge.headers.get("payment-required");
  if (!prHeader) throw new Error("402 response missing PAYMENT-REQUIRED header");

  const accepts = parsePaymentRequired(prHeader);
  const selected = accepts.find((a) => a.scheme === "period");
  if (!selected) throw new Error(`no "period" offer in accepts: ${JSON.stringify(accepts)}`);

  const extra = selected.extra as unknown as SubscriptionRequirementsExtra;
  const token = selected.asset as `0x${string}`;
  const permit2 = extra.contracts.permit2 as `0x${string}`;
  const subContract = extra.contracts.subscription as `0x${string}`;
  const amountPerPeriod = BigInt(extra.amountPerPeriod);
  const maxPeriods = BigInt(extra.maxPeriods);
  const initialAmount = BigInt(extra.initialCharge?.totalAmount ?? "0");
  const initialPeriods = BigInt(extra.initialCharge?.periodCount ?? 0);
  const totalCommitment = initialAmount + (maxPeriods - initialPeriods) * amountPerPeriod;

  console.log(
    `Offer: plan "${extra.plan.id}" — ${Number(amountPerPeriod) / 1e6} per period × ${maxPeriods} periods (commitment ${Number(totalCommitment) / 1e6})`
  );

  // 2. Balance + ERC20→Permit2 allowance
  const [balance, erc20Allowance] = await Promise.all([
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, permit2],
    }),
  ]);
  console.log(`Token balance: ${Number(balance) / 1e6}`);
  if (balance < initialAmount) {
    throw new Error(
      `insufficient token balance for first charge: have ${Number(balance) / 1e6}, need ${Number(initialAmount) / 1e6}`
    );
  }
  if (erc20Allowance < totalCommitment) {
    console.log("Approving Permit2 for the token (one-time on-chain tx, needs OKB gas)...");
    const txHash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [permit2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`Approved: ${txHash}`);
  } else {
    console.log("Permit2 already approved.");
  }

  // 3. Current Permit2 nonce (docs: use current value, NOT +1)
  const [, , nonce] = await publicClient.readContract({
    address: permit2,
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [account.address, token, subContract],
  });
  console.log(`Permit2 nonce: ${nonce}`);

  // 4. Sign PermitSingle + SubscriptionTerms
  const now = Math.floor(Date.now() / 1000);
  const periodSec = extra.periodSec || 2_592_000;
  // Allowance must outlive the whole subscription; +30d slack.
  const expiration = now + Number(maxPeriods) * periodSec + 30 * 24 * 3600;
  const sigDeadline = String(now + 3600);

  const permitEnvelope = buildPermit2TypedData({ selected, nonce, expiration, sigDeadline });
  const permitSingle = permitEnvelope.message as unknown as PermitSingleData;
  const permitSingleSignature = await account.signTypedData(
    permitEnvelope as Parameters<typeof account.signTypedData>[0]
  );

  const termsEnvelope = buildSubscriptionTermsTypedData({
    selected,
    payer: account.address,
    startAt: 0, // 0 = block.timestamp on-chain
    termsDeadline: now + 600,
    salt: `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`,
    permitHash: computePermitSingleStructHash(permitSingle),
  });
  const termsSignature = await account.signTypedData(
    termsEnvelope as unknown as Parameters<typeof account.signTypedData>[0]
  );

  // 5. Pay: same request, now with APP-PAYMENT
  const paymentHeader = encodePaymentPayload({
    selected,
    permitSingle,
    permitSingleSignature,
    terms: termsEnvelope.message,
    termsSignature,
  });

  console.log("Submitting subscription (facilitator settles first charge on-chain)...");
  const paid = await fetch(`${FRANK_URL}/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "APP-PAYMENT": paymentHeader },
    body: JSON.stringify({ projectName, docs }),
  });

  const body = await paid.text();
  if (!paid.ok) {
    throw new Error(`subscribe failed: HTTP ${paid.status} — ${body}`);
  }

  const settleHeader = paid.headers.get("payment-response");
  if (!settleHeader) {
    throw new Error(`paid request succeeded but no PAYMENT-RESPONSE header; body: ${body}`);
  }
  const settle = JSON.parse(Buffer.from(settleHeader, "base64").toString("utf8")) as {
    subId: string;
    txHash?: string;
  };

  console.log("\n✅ Subscribed!");
  console.log(`   subId:  ${settle.subId}`);
  if (settle.txHash) console.log(`   tx:     ${settle.txHash}`);
  console.log(`   onboard response: ${body}`);
  console.log(`\nAdd to your bot env:\nFRANK_SUB_ID=${settle.subId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
