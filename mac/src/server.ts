// The live panel: type a command, watch the coloured agents work, compare the jev brain with an LLM brain.
import { join } from "node:path";
import type { BrainKind, LogLine, RunTotals, Task } from "./contracts.ts";
import { AGENT_COLOURS } from "./contracts.ts";
import { JevBrain, LlmBrain } from "./decide.ts";
import { makeHelper } from "./helpers.ts";
import { CliDriver } from "./driver.ts";
import { LLM_BRAIN_MODEL, hasClaude } from "./llm.ts";
import { RunLogger } from "./logger.ts";
import { planTasks, runCommand, type PlannedTask } from "./manager.ts";
import { Explainer, type ToOverlay } from "./explain.ts";
import { route } from "./router.ts";
import { spokenSummary, tidyAnswer } from "./results.ts";
import { fromThisComputer } from "./localonly.ts";
import type { ServerWebSocket } from "bun";

interface RunRecord {
  runId: string;
  command: string;
  brain: BrainKind;
  model: string;
  status: "running" | "finished" | "stopped" | "error";
  tasks: Task[];
  totals?: RunTotals;
  error?: string;
  compareGroup?: string;
}

export function startPanel(port = Number(process.env.PORT ?? 3000)) {
  const driver = new CliDriver();
  const helper = makeHelper();
  const html = Bun.file(join(import.meta.dir, "..", "viewer", "index.html"));
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const runs: RunRecord[] = [];
  const lines: LogLine[] = [];
  let busy = false;
  let abort: AbortController | null = null;

  const send = (event: string, data: unknown) => {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of clients) {
      try { c.enqueue(msg); } catch { clients.delete(c); }
    }
  };
  const snapshot = () => ({
    busy,
    runs,
    colours: AGENT_COLOURS,
    keys: { typesafe: !!process.env.TYPESAFE_API_KEY, anthropic: hasClaude() },
    llmModel: LLM_BRAIN_MODEL,
    medianClickMs: driver.medianClickMs(),
    fastLane: { on: driver.fast.on, ...driver.counts },
  });
  const push = () => { send("state", snapshot()); dock(); };

  async function execute(command: string, brain: BrainKind, plan?: PlannedTask[], compareGroup?: string): Promise<RunRecord> {
    const runId = `run-${brain}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const rec: RunRecord = { runId, command, brain, model: brain === "jev" ? "jev-1.13.0" : LLM_BRAIN_MODEL, status: "running", tasks: [], compareGroup };
    runs.unshift(rec);
    const log = new RunLogger(runId);
    log.subscribe((l) => {
      lines.push(l);
      if (lines.length > 600) lines.shift();
      send("line", l);
    });
    push();
    try {
      const res = await runCommand({
        runId, command, brainKind: brain,
        makeBrain: () => (brain === "llm" ? new LlmBrain() : new JevBrain()),
        helper, driver, log, signal: abort!.signal, plan,
        onUpdate: (tasks) => { rec.tasks = tasks; push(); },
      });
      rec.tasks = res.tasks;
      rec.totals = res.totals;
      rec.status = abort!.signal.aborted ? "stopped" : "finished";
    } catch (e: any) {
      rec.status = "error";
      rec.error = String(e?.message ?? e).slice(0, 300);
    }
    push();
    return rec;
  }

  function guard(brain: BrainKind | "both"): string | null {
    if (busy) return "the agents are busy: wait or press Stop";
    if ((brain === "jev" || brain === "both") && !process.env.TYPESAFE_API_KEY) return "TYPESAFE_API_KEY is missing in .env";
    if ((brain === "llm" || brain === "both") && !hasClaude()) return "ANTHROPIC_API_KEY is missing in .env";
    return null;
  }

  // the native overlay app (overlay/) connects here. It sends what you said or typed with the hotkey; we answer with
  // what to say and draw (explain mode), or start the agents and keep their widgets (bottom right) up to date.
  const overlays = new Set<ServerWebSocket<unknown>>();
  const toOverlays = (m: object) => { const s = JSON.stringify(m); for (const ws of overlays) ws.send(s); };
  const explainer = new Explainer(driver, (m: ToOverlay) => toOverlays(m), join(import.meta.dir, "..", "runs"));
  const short = (agent: string) => agent.replace(/-\d+$/, "");
  // every press / text insert flashes in the agent's colour where it happened (fast-lane actions have no Cua cursor)
  driver.cuaCursors = false; // the overlay draws each agent's cursor (gliding to every action, at fast-lane speed)
  driver.onAction = (n) => toOverlays({ type: "tap", agent: short(n.agent), colour: AGENT_COLOURS[n.agent] ?? "#2bb39a", kind: n.kind, via: n.via, x: n.frame.x, y: n.frame.y, w: n.frame.w, h: n.frame.h });

  /** the agents' widgets: the latest run's tasks */
  function dock() {
    const rec = runs[0];
    if (!rec || !overlays.size) return;
    toOverlays({
      type: "agents", runId: rec.runId, running: rec.status === "running",
      tasks: rec.tasks.map((t) => ({
        id: `${rec.runId}/${t.id}`, name: short(t.agent), colour: AGENT_COLOURS[t.agent] ?? "#888888", app: t.app, goal: t.goal.charAt(0).toUpperCase() + t.goal.slice(1),
        status: t.status, now: t.now ?? "", answer: tidyAnswer(t.answer ?? ""), reason: t.exception?.reason ?? "",
        seconds: Math.round(t.seconds * 10) / 10, steps: t.steps, llm: t.llmCalls.length, windowId: t.windowId ?? 0,
      })),
    });
  }

  /** the hotkey's words: a job for the agents, or a question for explain mode */
  async function hotkey(text: string, cursor?: { x: number; y: number }) {
    const q = text.trim();
    if (!q) return explainer.ask(q, cursor);
    const r = await route(q, { lesson: explainer.inLesson, agentsBusy: busy });
    console.log(`[route] "${q.slice(0, 60)}" → ${r.to} (${r.via}${r.confidence !== undefined ? ` ${r.confidence.toFixed(2)}` : ""}, ${r.ms} ms)`);
    if (r.to === "explain") return explainer.ask(q, cursor);
    explainer.discard();
    if (r.to === "stop") { abort?.abort(); return explainer.say("Stopping the agents.", 4000); }
    const err = guard("jev");
    if (err) return explainer.say(`${err[0]!.toUpperCase()}${err.slice(1)}.`, 6000);
    busy = true;
    abort = new AbortController();
    explainer.say("On it.", 3000);
    void execute(q, "jev")
      .then((rec) => explainer.say(spokenSummary(rec.tasks, rec.status, rec.error), 12000))
      .catch((e) => explainer.say(`Something went wrong: ${String(e?.message ?? e).slice(0, 120)}`, 8000))
      .finally(() => { busy = false; push(); });
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1", // this computer only: nobody else on the Wi-Fi can reach the panel or start agents
    idleTimeout: 0,
    websocket: {
      open(ws) { overlays.add(ws); console.log(`[explain] overlay connected (${overlays.size})`); dock(); },
      close(ws) { overlays.delete(ws); },
      message(_ws, raw) {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m.type === "begin") explainer.begin(); // hotkey down: capture the screen now (dropped if it's a job for the agents)
        else if (m.type === "stop") abort?.abort(); // the overlay's menu: Stop agents
        else if (m.type === "step") explainer.go(m.go === "back" ? "back" : m.go === "repeat" ? "repeat" : "next"); // ⌃⌥ → / ←
        else if (m.type === "dismiss") explainer.dismiss(); // Esc twice
        else if (m.type === "key") console.log(`[keys] ${String(m.what ?? "").slice(0, 60)}`);
        else if (m.type === "ask") {
          console.log(`[hotkey] "${String(m.text ?? "").slice(0, 80)}"`);
          void hotkey(String(m.text ?? ""), m.cursor).catch((e) => console.error("[hotkey]", e));
        }
      },
    },
    async fetch(req, srv) {
      if (!fromThisComputer(req)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/overlay") return srv.upgrade(req) ? undefined : new Response("websocket only", { status: 400 });
      const json = (o: unknown, status = 200) => Response.json(o, { status });
      if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/events") {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              clients.add(c);
              c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`));
              for (const l of lines.slice(-200)) c.enqueue(enc.encode(`event: line\ndata: ${JSON.stringify(l)}\n\n`));
            },
            cancel() { clients.delete(ctl); },
          }),
          { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } },
        );
      }
      if (url.pathname === "/api/state") return json(snapshot());
      if (req.method === "POST" && url.pathname === "/api/run") {
        const { command, brain } = (await req.json()) as { command: string; brain: BrainKind };
        const b: BrainKind = brain === "llm" ? "llm" : "jev";
        const err = !command?.trim() ? "type a command first" : guard(b);
        if (err) return json({ ok: false, error: err });
        busy = true;
        abort = new AbortController();
        void execute(command.trim(), b).finally(() => { busy = false; push(); });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/compare") {
        const { command } = (await req.json()) as { command: string };
        const err = !command?.trim() ? "type a command first" : guard("both");
        if (err) return json({ ok: false, error: err });
        busy = true;
        abort = new AbortController();
        void (async () => {
          // plan ONCE so both brains get identical tasks; both start from a clean state
          const apps = await driver.listApps();
          const p = await planTasks(command.trim(), apps);
          const plan = p.tasks.map((t) => ({ ...t, goal: `${t.goal} (Do the whole task from the beginning, even if its result is already visible.)` }));
          const group = `cmp-${Date.now()}`;
          await execute(command.trim(), "jev", plan, group);
          if (!abort!.signal.aborted) await execute(command.trim(), "llm", plan, group);
        })().catch((e) => console.error(e)).finally(() => { busy = false; push(); });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        abort?.abort();
        return json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}
