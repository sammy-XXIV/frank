/**
 * Buyer-side client for Frank's paid API — pay-per-call "exact" scheme.
 *
 * Flow per request: POST → 402 challenge (PAYMENT-REQUIRED header) → SDK signs
 * an EIP-3009 transferWithAuthorization for the listed price with the bot's
 * wallet → retry with PAYMENT-SIGNATURE header → 200 + PAYMENT-RESPONSE
 * (settlement receipt, incl. on-chain tx hash). All signing is silent and
 * off-chain; settlement happens facilitator-side on X Layer.
 */
import { x402Client, x402HTTPClient } from "@okxweb3/app-x402-core/client";
import { registerExactEvmScheme } from "@okxweb3/app-x402-evm/exact/client";
import { createPublicClient, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { xLayer } from "viem/chains";

const USDT0 = "0x779ded0c9e1022225f8e0630b35a9b54be713736" as const;

export interface FrankClientConfig {
  baseUrl: string; // e.g. https://frank-production-83d3.up.railway.app
  privateKey: `0x${string}`; // payer wallet key — funds each call
}

export interface QaResult {
  answered: boolean;
  answer: string;
  groundedIn: string;
  confidence: "high" | "medium" | "low";
}

export interface DisputeResult {
  summary: string;
  ruleViolation: boolean;
  violatingParty: string | null;
  ruleViolated: string | null;
  reasoning: string;
  recommendedAction: "none" | "warn" | "timeout_5m" | "timeout_1h" | "timeout_1d" | "escalate_to_human";
  confidence: "high" | "medium" | "low";
}

export interface EventResult {
  announcementText: string;
  groundedInTone: string;
}

export interface Settlement {
  path: string;
  at: number;
  /** Decoded PAYMENT-RESPONSE from the seller (tx hash etc.), if present. */
  receipt: unknown;
}

export class FrankApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`Frank API ${status}: ${JSON.stringify(body)}`);
  }
}

export class FrankClient {
  private account: PrivateKeyAccount;
  private http: x402HTTPClient;
  /** Most recent settlement receipt — handy for demo logging. */
  lastSettlement: Settlement | null = null;

  constructor(private cfg: FrankClientConfig) {
    this.account = privateKeyToAccount(cfg.privateKey);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: this.account });
    this.http = new x402HTTPClient(client);
  }

  get payer(): string {
    return this.account.address;
  }

  /** USDT0 balance of the paying wallet, human units (e.g. "12.35"). */
  async balance(): Promise<string> {
    const chainClient = createPublicClient({
      chain: xLayer,
      transport: http(process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech"),
    });
    const raw = await chainClient.readContract({
      address: USDT0,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.account.address],
    });
    return formatUnits(raw, 6);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" } as Record<string, string>,
      body: JSON.stringify(body),
    };

    let res = await fetch(url, init);

    if (res.status === 402) {
      // Decode challenge, sign the per-call payment, retry once.
      const paymentRequired = this.http.getPaymentRequiredResponse((name) =>
        res.headers.get(name)
      );
      const payload = await this.http.createPaymentPayload(paymentRequired);
      const payHeaders = this.http.encodePaymentSignatureHeader(payload);
      res = await fetch(url, {
        ...init,
        headers: { ...init.headers, ...payHeaders },
      });
    }

    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new FrankApiError(res.status, json);

    const receiptHeader = res.headers.get("payment-response");
    if (receiptHeader) {
      try {
        this.lastSettlement = {
          path,
          at: Date.now(),
          receipt: JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8")),
        };
        console.log(`[frank-client] paid ${path}:`, JSON.stringify(this.lastSettlement.receipt));
      } catch {
        // receipt is informational only — never fail the call over it
      }
    }
    return json as T;
  }

  onboard(projectName: string, docs: string): Promise<{ ok: true }> {
    return this.post("/onboard", { projectName, docs });
  }

  learn(update: string): Promise<{ ok: true; updates: number }> {
    return this.post("/learn", { update });
  }

  ask(question: string): Promise<QaResult> {
    return this.post("/qa", { question });
  }

  dispute(transcript: string): Promise<DisputeResult> {
    return this.post("/dispute", { transcript });
  }

  event(brief: string): Promise<EventResult> {
    return this.post("/event", { brief });
  }
}
