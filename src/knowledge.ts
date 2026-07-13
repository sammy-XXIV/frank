/**
 * A project's own docs/rules, supplied by the server owner at onboarding.
 * Every mode grounds its reasoning in this text directly — same "real
 * reference data, not vibes" pattern as Fit Check's occasion standards.
 * Kept as a single text blob (no vector search) — Claude's context window
 * handles this directly; a full RAG pipeline is more infra than a v1 needs.
 */
export interface ProjectKnowledge {
  projectName: string;
  docs: string; // concatenated docs: rules, FAQ, tone/style guide, whatever the owner provides
  /** Incremental updates learned after onboarding (announcements, /learn). Newest last. */
  updates?: KnowledgeUpdate[];
}

export interface KnowledgeUpdate {
  at: string; // ISO date
  text: string;
}

// Base docs are never trimmed; only the update log is, oldest-first, once it
// exceeds this. Keeps the context block bounded no matter how chatty the
// announcements channel is. Together with MAX_DOCS_CHARS this bounds
// worst-case input tokens per call — which is what the subscription price's
// margin math assumes; raising either cap means repricing.
const MAX_UPDATES_CHARS = 10_000;

/** Enforced at /onboard. ~4k tokens — the ceiling the $14.99/mo margin was computed against. */
export const MAX_DOCS_CHARS = 16_000;

export function appendUpdate(kb: ProjectKnowledge, text: string): ProjectKnowledge {
  const updates = [...(kb.updates ?? []), { at: new Date().toISOString().slice(0, 10), text }];
  let total = updates.reduce((n, u) => n + u.text.length, 0);
  while (total > MAX_UPDATES_CHARS && updates.length > 1) {
    total -= updates[0].text.length;
    updates.shift();
  }
  return { ...kb, updates };
}

export function knowledgeBlock(kb: ProjectKnowledge): string {
  const updatesBlock = kb.updates?.length
    ? `

RECENT UPDATES (newer information — where these conflict with the docs above, the update wins):
${kb.updates.map((u) => `[${u.at}] ${u.text}`).join("\n")}`
    : "";

  return `PROJECT: ${kb.projectName}

PROJECT DOCS / RULES (this is the ONLY source of truth — do not use outside knowledge about this project):
${kb.docs}${updatesBlock}`;
}
