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
}

export function knowledgeBlock(kb: ProjectKnowledge): string {
  return `PROJECT: ${kb.projectName}

PROJECT DOCS / RULES (this is the ONLY source of truth — do not use outside knowledge about this project):
${kb.docs}`;
}
