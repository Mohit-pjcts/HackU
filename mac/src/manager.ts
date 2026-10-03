// The dispatcher and the agent manager.
//   command ("compute 45x12 in Calculator and write a packing list in TextEdit")
//     -> plan: one task per app (Claude Haiku, ONE call per command; a simple parser if there is no key)
//     -> one coloured agent per task, all running at the same time
// Agents think in parallel. With the fast lane (src/fastlane.ts) their clicks and native text inserts are parallel too;
// what still goes through Cua (web typing, keys, launching) shares its single input lane.
import { WORD_DOC } from "./compile.ts";
import type { AppInfo, Brain, BrainKind, Driver, Helper, Logger, RunTotals, Task } from "./contracts.ts";
import { AGENT_NAMES } from "./contracts.ts";
import { prepareWindow, matchApp } from "./apps.ts";
import { HELPER_MODEL, callTool, hasClaude } from "./llm.ts";
import { JevBrain } from "./decide.ts";
import { nowIso } from "./logger.ts";
import { runTask } from "./loop.ts";

export interface PlannedTask { app: string; goal: string; url?: string }

const COMMON_APPS = ["Calculator", "TextEdit", "Safari", "Notes", "Reminders", "Calendar", "Finder", "System Settings", "Maps", "Music", "Weather", "Stocks"];

/** without an Anthropic key: "Calculator: compute 6x7; TextEdit: write hi" or "... in Calculator" */
export function planWithoutLlm(command: string, appNames: string[]): PlannedTask[] {
  const parts = command.split(/;|\band then\b|\bthen\b|\band\b(?=[^,]*\bin [A-Z])/i).map((s) => s.trim()).filter(Boolean);
  const out: PlannedTask[] = [];
  for (const part of parts) {
    const colon = part.match(/^([A-Za-z ]{3,30}):\s*(.+)$/);
    if (colon && appNames.some((a) => a.toLowerCase() === colon[1]!.trim().toLowerCase())) {
      out.push({ app: colon[1]!.trim(), goal: colon[2]!.trim() });
      continue;
    }
    const hit = appNames.find((a) => new RegExp(`\\b(in|on|using|with|open)\\s+${a.replace(/ /g, "\\s+")}\\b`, "i").test(part));
    if (hit) out.push({ app: hit, goal: part });
  }
  return out;
}

const APP_USES: Record<string, string> = {
  Safari: "the web browser: search the internet, look things up, websites, videos",
  Calculator: "arithmetic and calculations",
  TextEdit: "write or edit a plain text document",
  Notes: "write notes, lists, plans, itineraries, drafts",
  Reminders: "to-do items and reminders",
  Calendar: "events and schedules",
  Finder: "files and folders",
  Maps: "places, directions, travel times",
  Music: "play music",
  Weather: "the weather forecast app",
  Stocks: "stock prices and markets",
  Claude: "chat with the Claude AI assistant",
  "System Settings": "Mac settings",
};
const compact = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** a clause that asks for something (an action or a question); anything else is context */
const TASKY = /\b(open|launch|start|compute|calculate|work out|clear|add|subtract|multiply|divide|write|type|draft|make|create|save|search|look up|google|find|play|watch|organi[sz]e|sort|tidy|move|rename|put|set|send|go to|visit|show|take|check|get|tell|convert|book|list|note|remind|what|how|when|where|who|which|why)\b|\?/i;
const WRITING = /\b(write|plan|draft|list|itinerary|note|jot)\b/i;

const BROWSER_HINT = /\b(youtube|wikipedia|google|website|web ?page|the web|online|browser|url|http|\.com\b|\.org\b|\.hk\b)/i;

/** split "Use three agents. Use one to X. Use an agent to Y. And ask Claude to Z." into "X", "Y", "ask Claude to Z" */
export function splitCommand(command: string): string[] {
  return splitClauses(command).map((c) => c.text);
}

/** clauses, each marked newAgent when the user explicitly asked for another agent ("use an agent to ...") */
export function splitClauses(command: string): { text: string; newAgent: boolean }[] {
  const out: { text: string; newAgent: boolean }[] = [];
  for (const sentence of command.split(/(?<=[.!?])\s+|;\s*|\n+/)) {
    // split only where a NEW clause starts: "... and in TextEdit write ...", "... and ask Claude ...",
    // "..., in Weather check ...", "..., and make a word doc ..."
    const parts = sentence.split(/,?\s+and\s+(?=(?:then\s+)?(?:in|on|use|using|ask)\s)|,\s+(?=(?:and\s+)?(?:then\s+)?(?:in|on|using)\s+(?:a\s+new\s+|the\s+)?[A-Z])|,\s+and\s+(?=(?:then\s+)?(?:make|write|create|draft|open|play|compute|calculate|check|find|search|look up|organi[sz]e|sort|get)\b)/);
    for (let p of parts) {
      p = p.trim().replace(/[.]+$/, "").replace(/^and\s+/i, "");
      if (!p || /^(?:please\s+)?use\s+(?:\w+\s+)?(?:agents?|agents?)$/i.test(p)) continue; // "Use three agents"
      const agentPrefix = /^(?:and\s+)?(?:then\s+)?(?:use|have|get)\s+(?:one|an agent|another(?: agent)?|the (?:first|second|third|fourth|last)(?: agent)?|an agent|another agent|one agent)\s+(?:to\s+)?/i;
      const newAgent = agentPrefix.test(p);
      p = p.replace(agentPrefix, "").trim();
      if (p) out.push({ text: p, newAgent });
    }
  }
  return out;
}

/** no LLM: split in code; the app is the one named, else a browser for web words, else jev picks it (one cheap choice) */
/** a folder the user names by path ("~/Desktop/stuff", "/Users/me/x"): the Finder window is opened there */
export function folderIn(clause: string): string | undefined {
  const m = clause.match(/(?:^|\s)((?:~|\/Users)\/[^\s,;"'“”]+(?:\s(?![a-z]+\b)[^\s,;]+)*)/);
  return m ? m[1]!.replace(/[.,;:]$/, "") : undefined;
}

export async function planWithJev(command: string, names: string[]): Promise<{ tasks: PlannedTask[]; costUsd: number; ms: number }> {
  const t0 = performance.now();
  let cost = 0;
  const browser = names.includes("Safari") ? "Safari" : names.find((n) => /chrome|brave|firefox|arc/i.test(n)) ?? "Safari";
  const brain = process.env.TYPESAFE_API_KEY ? new JevBrain() : null;
  const tasks: PlannedTask[] = [];
  for (const { text: clause, newAgent } of splitClauses(command)) {
    // "I'm flying to Tokyo tomorrow." asks for nothing: context, not a task for an agent
    if (!TASKY.test(clause) && !names.some((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(clause))) continue;
    // an app named as the PLACE ("in a new Brave window", "on Safari", "using Notes") wins; otherwise the app
    // mentioned first ("use Claude ... about the weather" is a Claude task)
    let named: string | undefined;
    let at = Infinity;
    const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    const alias = (n: string) => (n === "Brave Browser" ? "brave(?:\\s+browser)?" : n === "Google Chrome" ? "(?:google\\s+)?chrome" : esc(n));
    for (const n of names) {
      const place = new RegExp(`\\b(?:in|on|using|with|via)\\s+(?:a\\s+new\\s+|the\\s+|my\\s+)?${alias(n)}\\b`, "i").exec(clause);
      if (place) { named = n; at = -1; break; }
    }
    if (!named) for (const n of names) {
      const m = new RegExp(`\\b${alias(n)}\\b`, "i").exec(clause);
      if (m && (m.index < at || (m.index === at && n.length > (named?.length ?? 0)))) { named = n; at = m.index; }
    }
    // written without its spaces or capitals ("appstore", "system settings" as "systemsettings")
    if (!named) named = names.filter((n) => compact(n).length >= 5 && compact(clause).includes(compact(n))).sort((a, b) => b.length - a.length)[0];
    if (named === "Finder") { tasks.push({ app: named, goal: clause, url: folderIn(clause) }); continue; }
    if (WORD_DOC.test(clause) && (!named || /^(TextEdit|Microsoft Word|Notes|Pages)$/.test(named)) && names.includes("TextEdit")) { tasks.push({ app: "TextEdit", goal: clause }); continue; }
    if (named) { tasks.push({ app: named, goal: clause }); continue; }
    if (BROWSER_HINT.test(clause)) { tasks.push({ app: browser, goal: clause }); continue; }
    // "Clear the calculator. Then compute ..." style: a clause that names no app continues the previous one
    if (tasks.length && !newAgent) { tasks.push({ app: tasks[tasks.length - 1]!.app, goal: clause }); continue; }
    if (!brain?.choose) continue;
    const options: Record<string, string> = Object.fromEntries(names.map((n) => [n, `${n}: ${APP_USES[n] ?? "a macOS app"}`]));
    // jev can time out: that must not crash the run (it did: "Request timed out after 4000ms")
    const c = await brain.choose(`Which app should an agent use to do this task: ${clause}`, options, { task: clause }).catch(() => ({ choice: "", confidence: 0, costUsd: 0 }));
    cost += c.costUsd;
    let app = c.confidence >= 0.4 ? c.choice : WRITING.test(clause) && names.includes("Notes") ? "Notes" : browser;
    if (/chrome|brave|firefox|arc|safari/i.test(app)) app = browser; // the user's default browser
    tasks.push({ app, goal: clause });
  }
  return { tasks, costUsd: cost, ms: Math.round(performance.now() - t0) };
}

export type PlannerMode = "jev" | "llm";
export const plannerMode = (): PlannerMode => (process.env.HELPER === "haiku" ? "llm" : "jev");

export async function planTasks(command: string, apps: AppInfo[], mode: PlannerMode = plannerMode()): Promise<{ tasks: PlannedTask[]; costUsd: number; ms: number; via: "llm" | "parser" | "jev" }> {
  const names = [...new Set([...COMMON_APPS, ...apps.filter((a) => a.running).map((a) => a.name)])].filter((n) => apps.some((a) => a.name === n));
  // an app the user names explicitly also counts, even if it is not running
  for (const a of apps) if (a.name.length >= 4 && (new RegExp(`\\b${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(command) || (compact(a.name).length >= 5 && compact(command).includes(compact(a.name)))) && !names.includes(a.name)) names.push(a.name);
  if (mode === "jev") return { ...(await planWithJev(command, names)), via: "jev" };
  if (!hasClaude()) return { tasks: planWithoutLlm(command, names), costUsd: 0, ms: 0, via: "parser" };
  const r = await callTool<{ tasks: PlannedTask[] }>({
    model: HELPER_MODEL,
    system:
      "You split a user's instruction into tasks for agents that each operate ONE macOS app window. " +
      "One task per app (merge everything for the same app into one goal). Each goal must be self-contained and concrete, " +
      "including every value needed (numbers, text to write, what to search). Use only app names from the list. " +
      "For a Finder task give url = the absolute path of the folder (the user's home folder is " + process.env.HOME + "; e.g. " + process.env.HOME + "/Downloads). " +
      "For a web task use Safari and ALWAYS give url: prefer a URL that already encodes the search (https://www.google.com/search?q=..., https://en.wikipedia.org/w/index.php?search=..., https://www.google.com/travel/flights?q=...). At most 4 tasks.",
    user: JSON.stringify({ instruction: command, available_apps: names }),
    tool: {
      name: "plan",
      description: "The tasks, one per app.",
      input_schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { app: { type: "string" }, goal: { type: "string" }, url: { type: "string" } },
              required: ["app", "goal"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    maxTokens: 700,
  });
  return { tasks: (r.input.tasks ?? []).slice(0, 4), costUsd: r.costUsd, ms: r.ms, via: "llm" };
}

export function totalsOf(tasks: Task[], seconds: number): RunTotals {
  const ms = tasks.flatMap((t) => t.decideMs).sort((a, b) => a - b);
  return {
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    seconds,
    decisionsUsd: tasks.reduce((a, t) => a + t.cost.decisionsUsd, 0),
    helperUsd: tasks.reduce((a, t) => a + t.cost.helperUsd, 0),
    decisions: tasks.reduce((a, t) => a + t.counts.decisions, 0),
    actions: tasks.reduce((a, t) => a + t.counts.actions, 0),
    medianDecideMs: ms.length ? ms[Math.floor(ms.length / 2)]! : 0,
  };
}

export interface RunOpts {
  runId: string;
  command: string;
  brainKind: BrainKind;
  makeBrain: () => Brain;
  helper: Helper;
  driver: Driver;
  log: Logger;
  signal: AbortSignal;
  onUpdate?: (tasks: Task[]) => void;
  /** reuse a plan (so a comparison runs both brains on identical tasks) */
  plan?: PlannedTask[];
  plannerMode?: PlannerMode;
}

export async function runCommand(o: RunOpts): Promise<{ tasks: Task[]; totals: RunTotals; plan: PlannedTask[]; planCostUsd: number }> {
  const t0 = performance.now();
  const apps = await o.driver.listApps();
  let plan = o.plan;
  let planCostUsd = 0;
  if (!plan) {
    const p = await planTasks(o.command, apps, o.plannerMode);
    plan = p.tasks;
    planCostUsd = p.costUsd;
  }
  // never two agents on one app: merge
  const merged: PlannedTask[] = [];
  for (const t of plan) {
    const same = merged.find((m) => m.app.toLowerCase() === t.app.toLowerCase());
    if (same) same.goal += ` Then: ${t.goal}`;
    else merged.push({ ...t });
  }
  const tasks: Task[] = merged.map((t, i) => ({
    id: `t${i + 1}`,
    agent: AGENT_NAMES[i % AGENT_NAMES.length]!,
    app: t.app,
    goal: t.goal,
    brain: o.brainKind,
    status: "queued",
    steps: 0,
    seconds: 0,
    cost: { decisionsUsd: 0, helperUsd: 0 },
    counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 },
    decideMs: [], llmCalls: [],
  }));
  o.log.write({ type: "run_start", runId: o.runId, t: nowIso(), command: o.command, brain: o.brainKind, tasks });
  o.onUpdate?.(tasks);

  await Promise.all(
    tasks.map(async (task, i) => {
      const app = matchApp(apps, task.app);
      if (!app) {
        task.status = "failed";
        task.exception = { code: "no_app", reason: `no installed app called "${task.app}"` };
        o.log.write({ type: "task_end", runId: o.runId, t: nowIso(), task });
        o.onUpdate?.(tasks);
        return;
      }
      task.app = app.name;
      task.bundleId = app.bundle_id;
      try {
        await o.driver.ensureSession(task.agent);
        const { win, note } = await prepareWindow(o.driver, task.agent, app, merged[i]!.url);
        task.windowId = win.windowId;
        if (note) task.now = note;
        await runTask({ runId: o.runId, driver: o.driver, brain: o.makeBrain(), helper: o.helper, log: o.log, signal: o.signal, win, onUpdate: () => o.onUpdate?.(tasks) }, task);
      } catch (e: any) {
        task.status = "failed";
        task.exception = { code: "error", reason: String(e?.message ?? e).slice(0, 240) };
        o.log.write({ type: "task_end", runId: o.runId, t: nowIso(), task });
      } finally {
        o.onUpdate?.(tasks);
      }
    }),
  );
  for (const t of tasks) await o.driver.endSession(t.agent).catch(() => {});
  const totals = totalsOf(tasks, (performance.now() - t0) / 1000);
  totals.helperUsd += planCostUsd;
  o.log.write({ type: "run_end", runId: o.runId, t: nowIso(), totals, tasks });
  return { tasks, totals, plan: merged, planCostUsd };
}
