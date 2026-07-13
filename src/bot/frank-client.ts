/**
 * Buyer-side client for Frank's paid API.
 *
 * Every paid call carries an EIP-191 AccessProof in the APP-ACCESS header:
 * keccak256(abi.encodePacked(subId, payer, timestamp)) signed by the payer
 * wallet — the same message `AccessProofVerifier` reconstructs server-side
 * (verified against @okxweb3/app-x402-evm dist, not guessed). Proofs are
 * replay-bounded to a ±300s window, so one is signed fresh per request.
 *
 * Requires an ALREADY-ACTIVE subscription (the subscribe flow itself — permit2
 * + terms signing — is a separate one-time step, not done here).
 */
import {
  buildAccessProofMessage,
  encodeAccessProof,
} from "@okxweb3/app-x402-core/subscription";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export interface FrankClientConfig {
  baseUrl: string; // e.g. https://frank-production-83d3.up.railway.app
  subId: `0x${string}`; // subscription id from the subscribe flow
  privateKey: `0x${string}`; // payer wallet key — the wallet that subscribed
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

  constructor(private cfg: FrankClientConfig) {
    this.account = privateKeyToAccount(cfg.privateKey);
  }

  get payer(): string {
    return this.account.address;
  }

  private async accessHeader(): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = buildAccessProofMessage({
      subId: this.cfg.subId,
      payer: this.account.address,
      timestamp,
    });
    const signature = await this.account.signMessage({ message: { raw: message } });
    return encodeAccessProof({
      kind: "subscription-id",
      subId: this.cfg.subId,
      payer: this.account.address,
      timestamp,
      signature,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "APP-ACCESS": await this.accessHeader(),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new FrankApiError(res.status, json);
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
