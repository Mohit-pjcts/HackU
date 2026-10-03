// Benchmark: the same tasks with the Haiku helper and with the jev helper (no LLM in the normal path).
// Each task has an INDEPENDENT check (not the agent's own "done"). Run: bun run src/bench.ts [--only jev|llm]
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./contracts.ts";
import { JevBrain, LlmBrain } from "./decide.ts";
import { CliDriver } from "./driver.ts";
import { makeHelper } from "./helpers.ts";
import { RunLogger } from "./logger.ts";
import { runCommand, type PlannerMode } from "./manager.ts";
import { perceive } from "./perceive.ts";
import { windowsOf } from "./apps.ts";

const SANDBOX = join(import.meta.dir, "..", "scratch", "finder-test");
const FILES = ["Lecture 3 slides.pdf", "Assignment 2.pdf", "Receipt Sept.pdf", "team photo.png", "screenshot 2026-10-02.png", "logo.jpg", "notes.txt", "todo.txt", "budget.csv", "pitch draft.docx"];
function resetSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });
  for (const f of FILES) writeFileSync(join(SANDBOX, f), "dummy test file\n");
}

const driver = new CliDriver();
async function textEditShows(text: string): Promise<boolean> {
  for (const w of (await windowsOf(driver, "TextEdit")).filter((x) => /-\d{13}/.test(x.title))) {
    const o = await driver.observe("Mint-3", w);
    if (perceive(o).screen.some((l) => l.includes(text))) return true;
  }
  return false;
}

interface Case { name: string; command: string; before?: () => void; check: (t: Task[]) => Promise<boolean> | boolean }
const ans = (t: Task[]) => t.map((x) => x.answer ?? "").join(" | ");
const CASES: Case[] = [
  { name: "calc ×", command: "Clear the calculator and compute 128 times 37 in Calculator", check: (t) => /4,?736/.test(ans(t)) },
  { name: "calc %", command: "In Calculator compute 15% of 2480", check: (t) => /\b372\b/.test(ans(t)) },
  { name: "wikipedia", command: "In Safari, look up the University of Hong Kong on Wikipedia and tell me the year it was founded", check: (t) => /1911|1887/.test(ans(t)) },
  { name: "web search", command: "In Safari find the population of Hong Kong", check: (t) => /7[.,]\d+\s*million|7,\d{3},\d{3}|7\.\d+ ?m\b/i.test(ans(t)) },
  { name: "textedit", command: "In TextEdit write 'The demo starts at 3pm'", check: () => textEditShows("The demo starts at 3pm") },
  {
    name: "finder sort",
    command: `In Finder, organise the files in ${SANDBOX} into folders by type`,
    before: resetSandbox,
    check: () => readdirSync(SANDBOX).filter((n) => !n.startsWith(".") && statSync(join(SANDBOX, n)).isFile()).length === 0,
  },
];

// tasks NO compiler covers: here the LLM should be used only when jev actually needs it
async function safariTitle(): Promise<string> {
  const ws = await windowsOf(driver, "Safari");
  return ws.map((w) => w.title).join(" | ");
}
async function textEditLines(min: number): Promise<boolean> {
  for (const w of (await windowsOf(driver, "TextEdit")).filter((x) => /-\d{13}/.test(x.title))) {
    const o = await driver.observe("Mint-3", w);
    const area = o.elements.find((e) => e.role === "AXTextArea");
    if ((area?.value ?? "").split("\n").filter((l) => l.trim()).length >= min) return true;
  }
  return false;
}
const UNCOVERED: Case[] = [
  { name: "youtube play", command: "Open YouTube in Safari and play the first video on the home page", check: async () => / - YouTube$/m.test((await safariTitle()).split(" | ").join("\n")) },
  { name: "packing list", command: "In TextEdit write a three item packing list for a weekend hiking trip", check: () => textEditLines(3) },
  { name: "calc square", command: "In Calculator work out the square of 17", check: (t) => /\b289\b/.test(ans(t)) },
  // not covered by any compiler: needs the LLM (escalation) or jev alone
  { name: "calc sequence", command: "In Calculator add 250 and 175, then subtract 80", check: (t) => /\b345\b/.test(ans(t)) },
];
if (process.argv.includes("--uncovered")) CASES.splice(0, CASES.length, ...UNCOVERED);
if (process.argv.includes("--all")) CASES.push(...UNCOVERED);
if (process.argv.includes("--case")) { const n = process.argv[process.argv.indexOf("--case") + 1]; const all = [...CASES, ...UNCOVERED]; CASES.splice(0, CASES.length, ...all.filter((c) => c.name === n)); }
if (process.argv.includes("--retest")) CASES.splice(0, CASES.length, ...CASES.filter((c) => c.name === "web search"), ...UNCOVERED);
const REPEAT = process.argv.includes("--repeat") ? Number(process.argv[process.argv.indexOf("--repeat") + 1]) : 1;
if (REPEAT > 1) { const base = [...CASES]; for (let i = 1; i < REPEAT; i++) CASES.push(...base); }

// modes: "jev" = Backstage (jev decides every step, LLM only when needed); "llm" = the Haiku helper with jev deciding;
// "all-llm" = an LLM for everything (Claude plans, decides every step and checks the result): the usual agent
type Mode = PlannerMode | "all-llm";
const only = process.argv.includes("--only") ? (process.argv[process.argv.indexOf("--only") + 1] as Mode) : undefined;
const modes: Mode[] = only ? [only] : ["llm", "jev"];
const rows: any[] = [];
for (const mode of modes) {
  for (const c of CASES) {
    c.before?.();
    const runId = `bench-${mode}-${c.name.replace(/\W+/g, "")}-${Date.now()}`;
    const t0 = performance.now();
    const allLlm = mode === "all-llm";
    const planner: PlannerMode = allLlm ? "llm" : mode;
    const res = await runCommand({
      runId, command: c.command, brainKind: allLlm ? "llm" : "jev", makeBrain: () => (allLlm ? new LlmBrain() : new JevBrain()), helper: makeHelper(planner),
      driver, log: new RunLogger(runId), signal: new AbortController().signal, plannerMode: planner,
    });
    const pass = await c.check(res.tasks);
    const row = {
      mode: mode === "jev" ? "jev helper" : mode === "all-llm" ? "LLM for all" : "Haiku helper", task: c.name,
      decisions: res.tasks.reduce((a, t) => a + t.counts.decisions, 0), decideMs: res.tasks.flatMap((t) => t.decideMs), pass, agentSaidDone: res.tasks.every((t) => t.status === "done"),
      seconds: +((performance.now() - t0) / 1000).toFixed(1), decisionsUsd: +res.totals.decisionsUsd.toFixed(6), helperUsd: +res.totals.helperUsd.toFixed(6),
      totalUsd: +(res.totals.decisionsUsd + res.totals.helperUsd).toFixed(6), answer: ans(res.tasks).slice(0, 90), why: res.tasks.map((t) => t.exception?.reason ?? "").join(" ").slice(0, 120),
      llmCalls: res.tasks.flatMap((t) => t.llmCalls),
    };
    rows.push(row);
    console.log(`${row.mode.padEnd(13)} ${c.name.padEnd(13)} ${pass ? "PASS" : "FAIL"} (agent: ${row.agentSaidDone ? "done" : "failed"}) ${String(row.seconds).padStart(5)} s  $${row.totalUsd.toFixed(5)}  LLM×${row.llmCalls.length}  ${(row.answer || row.why).slice(0, 60)}`);
  }
}
const sum = (m: string) => {
  const r = rows.filter((x) => x.mode === m);
  return r.length ? `${m}: ${r.filter((x) => x.pass).length}/${r.length} pass, false "done" ${r.filter((x) => x.agentSaidDone && !x.pass).length}, ${r.reduce((a, x) => a + x.seconds, 0).toFixed(0)} s, $${r.reduce((a, x) => a + x.totalUsd, 0).toFixed(5)}, LLM calls ${r.reduce((a, x) => a + x.llmCalls.length, 0)}` : "";
};
console.log("\n" + ["Haiku helper", "jev helper", "LLM for all"].map(sum).filter(Boolean).join("\n"));
const out = join(import.meta.dir, "..", "runs", `bench-${Date.now()}.json`);
writeFileSync(out, JSON.stringify(rows, null, 1));
console.log(`saved ${out}`);
process.exit(0);
