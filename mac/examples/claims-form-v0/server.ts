// The live panel's server: state, server-sent events, and the few actions the panel can trigger.
import { join } from "node:path";
import { startReplica } from "../replica/server.ts";
import { Oracle } from "./adapters/claims-form.ts";
import { SEED_CLAIMS, newItem, runBatch } from "./batch.ts";
import type { BatchItem, Classifier, LogLine, Report } from "./contracts.ts";
import { AGENT } from "./contracts.ts";
import { FallbackClassifier, JevClassifier, PolicyClassifier } from "./decide.ts";
import { CliDriver } from "./driver.ts";
import type { AgentStatus } from "./loop.ts";
import { RunLogger } from "./logger.ts";
import { runPreflight, type Check } from "./preflight.ts";

interface PanelState {
  items: BatchItem[];
  agent: AgentStatus;
  running: boolean;
  classifier: { backend: string; degraded: boolean; note: string };
  report?: Report;
  checks?: Check[];
  daemonMedianClickMs?: number;
  runId?: string;
}

export function startPanel(port = Number(process.env.PORT ?? 3000)) {
  const driver = new CliDriver();
  const oracle = new Oracle();
  const html = Bun.file(join(import.meta.dir, "..", "viewer", "index.html"));
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();

  const state: PanelState = {
    items: [],
    agent: { agent: AGENT, status: "idle", step: 0 },
    running: false,
    classifier: { backend: process.env.TYPESAFE_API_KEY ? "jev" : "policy", degraded: false, note: "" },
  };
  let abort: AbortController | null = null;
  let counter = 0;
  let current: { logger: RunLogger; classifier: Classifier } | null = null;

  const send = (event: string, data: unknown) => {
    const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(msg);
      } catch {
        clients.delete(c);
      }
    }
  };
  const pushState = () => {
    state.daemonMedianClickMs = driver.medianClickMs();
    if (current && current.classifier instanceof FallbackClassifier) {
      state.classifier = { backend: current.classifier.degraded ? "policy" : "jev", degraded: current.classifier.degraded, note: current.classifier.lastError };
    }
    send("state", state);
  };
  const pickClassifier = (): Classifier => (process.env.TYPESAFE_API_KEY ? new FallbackClassifier(new JevClassifier()) : new PolicyClassifier());

  async function start() {
    if (state.running) return { ok: false, error: "a run is already in progress" };
    if (!state.items.some((i) => i.status === "pending")) return { ok: false, error: "add some claims first (or press 'Load demo batch')" };
    state.checks = await runPreflight(driver, AGENT, { openForm: true });
    pushState();
    const fatal = state.checks.filter((c) => c.fatal && !c.ok);
    if (fatal.length) return { ok: false, error: fatal.map((c) => `${c.name}: ${c.detail}`).join(" | ") };

    // each run starts from the items still waiting
    const runItems = state.items.filter((i) => i.status === "pending" || (i.status === "exception" && i.steps === 0));
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${++counter}`;
    const logger = new RunLogger(runId);
    const classifier = pickClassifier();
    current = { logger, classifier };
    state.runId = runId;
    state.report = undefined;
    state.running = true;
    state.classifier = { backend: classifier.backend === "jev" ? "jev" : "policy", degraded: false, note: "" };
    abort = new AbortController();
    logger.subscribe((l: LogLine) => {
      send("line", l);
      if (l.type === "item_end" || l.type === "run_end") pushState();
    });
    pushState();

    void (async () => {
      try {
        const report = await runBatch(
          { runId, driver, agent: AGENT, classifier, oracle, log: logger, signal: abort!.signal, onStatus: (s) => { state.agent = s; pushState(); } },
          runItems,
        );
        state.report = report;
      } catch (e: any) {
        state.agent = { agent: AGENT, status: "error", step: 0, note: String(e?.message ?? e) };
      } finally {
        state.running = false;
        state.agent = { agent: AGENT, status: "idle", step: 0 };
        await driver.endAll();
        pushState();
      }
    })();
    return { ok: true, runId };
  }

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (o: unknown, status = 200) => Response.json(o, { status });
      if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (url.pathname === "/events") {
        let ctl!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            clients.add(c);
            c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(state)}\n\n`));
            for (const l of current?.logger.lines ?? []) c.enqueue(enc.encode(`event: line\ndata: ${JSON.stringify(l)}\n\n`));
          },
          cancel() {
            clients.delete(ctl);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
      }
      if (url.pathname === "/api/state") return json(state);
      if (req.method === "POST" && url.pathname === "/api/items") {
        const { text } = (await req.json()) as { text: string };
        if (!text?.trim()) return json({ ok: false, error: "empty" }, 400);
        const item = newItem(`c${state.items.length + 1}`, text.trim(), "typed");
        state.items.push(item);
        pushState();
        return json({ ok: true, item });
      }
      if (req.method === "POST" && url.pathname === "/api/seed") {
        state.items = SEED_CLAIMS.map((t, i) => newItem(`c${i + 1}`, t, "seed"));
        state.report = undefined;
        pushState();
        return json({ ok: true, n: state.items.length });
      }
      if (req.method === "POST" && url.pathname === "/api/run") return json(await start());
      if (req.method === "POST" && url.pathname === "/api/stop") {
        abort?.abort();
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        abort?.abort();
        state.items = [];
        state.report = undefined;
        await oracle.reset().catch(() => {});
        pushState();
        return json({ ok: true });
      }
      if (url.pathname === "/api/preflight") {
        state.checks = await runPreflight(driver, AGENT, { openForm: false });
        pushState();
        return json(state.checks);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, state };
}

if (import.meta.main) {
  startReplica(8765);
  const { server } = startPanel();
  console.log(`replica claims form  http://127.0.0.1:8765/`);
  console.log(`live panel           http://127.0.0.1:${server.port}/`);
  console.log(process.env.TYPESAFE_API_KEY ? "classifier           TypeSafe jev" : "classifier           OFFLINE POLICY (no TYPESAFE_API_KEY in .env)");
}
