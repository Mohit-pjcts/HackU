// Which helper does planning / checking / free text:
//   HELPER=jev (default): compilers + plan cache + jev checks; an LLM only as a counted fallback (LLM_FALLBACK=off to disable)
//   HELPER=haiku: the original Claude Haiku planner / verifier / writer
import type { Helper } from "./contracts.ts";
import { ClaudeHelper } from "./decide.ts";
import { JevHelper } from "./jevhelper.ts";
import { hasClaude } from "./llm.ts";
import { plannerMode, type PlannerMode } from "./manager.ts";

export function makeHelper(mode: PlannerMode = plannerMode()): Helper {
  if (mode === "llm") return new ClaudeHelper();
  const fallback = process.env.LLM_FALLBACK !== "off" && hasClaude() ? new ClaudeHelper() : undefined;
  return new JevHelper(fallback);
}
