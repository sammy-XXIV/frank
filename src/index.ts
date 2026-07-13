import express from "express";
import { paymentMiddleware } from "@okxweb3/app-x402-express";
import {
  initPayments,
  quotaGuard,
  resourceServer,
  serverPlan,
  startChargeLoop,
  toAccept,
} from "./subscription.js";
import { answerQuestion, settleDispute, draftEventPost } from "./reasoning.js";
import { appendUpdate, MAX_DOCS_CHARS, type ProjectKnowledge } from "./knowledge.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? 3000;

// TODO before real launch: persist this (Postgres/Redis) — an in-memory map loses
// every server's docs on restart. Same caveat as the subscription InMemoryStore.
const knowledgeByPayer = new Map<string, ProjectKnowledge>();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const routes = {
  "POST /onboard": {
    accepts: [toAccept(serverPlan)],
    description: "Set or update your project's docs/rules that Frank grounds every answer in.",
    mimeType: "application/json",
  },
  // No quotaGuard on /learn or /onboard — neither calls Claude, so they cost
  // nothing per hit; the quota only meters the three LLM routes.
  "POST /learn": {
    accepts: [toAccept(serverPlan)],
    description:
      "Teach Frank an incremental update (announcement, rule change) without re-uploading all docs.",
    mimeType: "application/json",
  },
  "POST /qa": {
    accepts: [toAccept(serverPlan)],
    description: "Answer a member question using your project's own docs.",
    mimeType: "application/json",
    onBeforeAccess: quotaGuard,
  },
  "POST /dispute": {
    accepts: [toAccept(serverPlan)],
    description: "Adjudicate a dispute transcript against your project's actual rules.",
    mimeType: "application/json",
    onBeforeAccess: quotaGuard,
  },
  "POST /event": {
    accepts: [toAccept(serverPlan)],
    description: "Draft an event announcement in your project's established tone.",
    mimeType: "application/json",
    onBeforeAccess: quotaGuard,
  },
  "POST /subscription/cancel": {
    accepts: [toAccept(serverPlan)],
    description: "Cancel your Frank subscription.",
    mimeType: "application/json",
    operation: "cancel" as const,
  },
};

app.use(paymentMiddleware(routes, resourceServer));

function payerOf(req: express.Request): string {
  const payer = (req as any).x402?.subscription?.payer as string | undefined;
  if (!payer) throw new Error("no subscription context on request");
  return payer;
}

app.post("/onboard", (req, res) => {
  const { projectName, docs } = req.body as { projectName?: string; docs?: string };
  if (!projectName || !docs) {
    res.status(400).json({ error: "projectName and docs are required" });
    return;
  }
  if (docs.length > MAX_DOCS_CHARS) {
    res.status(400).json({
      error: `docs too large: ${docs.length} chars (max ${MAX_DOCS_CHARS}). Trim to the essentials — rules, FAQ, tone.`,
    });
    return;
  }
  knowledgeByPayer.set(payerOf(req), { projectName, docs });
  res.json({ ok: true });
});

app.post("/learn", (req, res) => {
  const payer = payerOf(req);
  const kb = knowledgeByPayer.get(payer);
  if (!kb) {
    res.status(409).json({ error: "no project docs on file — call /onboard first" });
    return;
  }
  const { update } = req.body as { update?: string };
  if (!update) {
    res.status(400).json({ error: "update is required" });
    return;
  }
  knowledgeByPayer.set(payer, appendUpdate(kb, update));
  res.json({ ok: true, updates: knowledgeByPayer.get(payer)!.updates!.length });
});

app.post("/qa", async (req, res) => {
  try {
    const kb = knowledgeByPayer.get(payerOf(req));
    if (!kb) {
      res.status(409).json({ error: "no project docs on file — call /onboard first" });
      return;
    }
    const { question } = req.body as { question?: string };
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }
    res.json(await answerQuestion(kb, question));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "qa failed", detail: (err as Error).message });
  }
});

app.post("/dispute", async (req, res) => {
  try {
    const kb = knowledgeByPayer.get(payerOf(req));
    if (!kb) {
      res.status(409).json({ error: "no project docs on file — call /onboard first" });
      return;
    }
    const { transcript } = req.body as { transcript?: string };
    if (!transcript) {
      res.status(400).json({ error: "transcript is required" });
      return;
    }
    res.json(await settleDispute(kb, transcript));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "dispute settlement failed", detail: (err as Error).message });
  }
});

app.post("/event", async (req, res) => {
  try {
    const kb = knowledgeByPayer.get(payerOf(req));
    if (!kb) {
      res.status(409).json({ error: "no project docs on file — call /onboard first" });
      return;
    }
    const { brief } = req.body as { brief?: string };
    if (!brief) {
      res.status(400).json({ error: "brief is required" });
      return;
    }
    res.json(await draftEventPost(kb, brief));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "event draft failed", detail: (err as Error).message });
  }
});

app.post("/subscription/cancel", (_req, res) => {
  res.json({ ok: true });
});

// 405 for non-POST hits on action routes, per x402 endpoint convention
// (learned from Fit Check's rejection — Express's default 404 isn't compliant).
for (const path of ["/onboard", "/learn", "/qa", "/dispute", "/event"]) {
  app.get(path, (_req, res) => {
    res.set("Allow", "POST").status(405).json({ error: "method not allowed, use POST" });
  });
}

await initPayments();
startChargeLoop();

app.listen(PORT, () => {
  console.log(`Frank listening on port ${PORT}`);
});
