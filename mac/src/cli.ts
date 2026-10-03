// bun run src/cli.ts "compute 128 x 37 in Calculator" [--brain llm]
import type { Task } from "./contracts.ts";
import { JevBrain, LlmBrain } from "./decide.ts";
import { makeHelper } from "./helpers.ts";
import { plannerMode } from "./manager.ts";
import { CliDriver } from "./driver.ts";
import { RunLogger } from "./logger.ts";
import { runCommand } from "./manager.ts";

const args = process.argv.slice(2);
const brainKind = args.includes("--brain") && args[args.indexOf("--brain") + 1] === "llm" ? "llm" : "jev";
const command = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--brain").join(" ");
if (!command) {
  console.log('usage: bun run src/cli.ts "<what the agents should do>" [--brain llm]');
  process.exit(1);
}
if (brainKind === "jev" && !process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY missing in .env");
if (!process.env.ANTHROPIC_API_KEY) console.log(plannerMode() === "jev" ? "note: no ANTHROPIC_API_KEY: jev runs alone, with no Claude fallback for stuck plans, borderline checks or creative text" : "note: no ANTHROPIC_API_KEY: planning uses a simple parser, and the writer/verifier are unavailable");

const runId = `cli-${brainKind}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const log = new RunLogger(runId);
log.subscribe((l) => {
  if (l.type === "run_start") console.log(`plan: ${l.tasks.map((t) => `${t.agent} → ${t.app}: ${t.goal}`).join("  |  ")}`);
  if (l.type === "step") {
    const d = l.decision;
    console.log(`  ${l.agent} s${l.step} ${d.backend}:${d.kind}${d.item !== undefined ? `#${d.item}` : ""} conf ${d.gate.toFixed(2)} · ${l.acted} · obs ${l.ms.observe} / decide ${l.ms.decide} / act ${l.ms.act} ms · $${d.costUsd.toFixed(6)}`);
  }
  if (l.type === "helper") console.log(`  ${l.agent} ${l.what}: ${l.detail} · ${l.ms} ms · $${l.costUsd.toFixed(5)}`);
  if (l.type === "task_end") {
    const t: Task = l.task;
    console.log(`${t.status === "done" ? "DONE  " : "FAILED"} ${t.agent} ${t.app}: ${t.answer ?? t.exception?.reason ?? ""} (${t.seconds.toFixed(1)} s, ${t.steps} steps, ${t.llmCalls.length ? "LLM ×" + t.llmCalls.length + ": " + t.llmCalls.join("; ") : "no LLM"})`);
  }
});
const driver = new CliDriver();
const res = await runCommand({
  runId, command, brainKind,
  makeBrain: () => (brainKind === "llm" ? new LlmBrain() : new JevBrain()),
  helper: makeHelper(), driver, log, signal: new AbortController().signal,
});
const t = res.totals;
console.log(`\nhelper mode: ${plannerMode() === "jev" ? "jev (compilers + cache, LLM only as fallback)" : "Claude Haiku"}`);
console.log(`${t.done}/${t.tasks} done in ${t.seconds.toFixed(1)} s · ${t.decisions} decisions (median ${t.medianDecideMs} ms) · decisions $${t.decisionsUsd.toFixed(5)} · helper LLM $${t.helperUsd.toFixed(5)}`);
console.log(`log: ${log.file}`);
process.exit(0);
