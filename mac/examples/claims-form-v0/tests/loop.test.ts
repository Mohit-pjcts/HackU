import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReplica } from "../replica/server.ts";
import { Oracle } from "../src/adapters/claims-form.ts";
import { newItem, runBatch } from "../src/batch.ts";
import type { Classifier, Decision, Facts, Item } from "../src/contracts.ts";
import { PolicyClassifier } from "../src/decide.ts";
import { RunLogger } from "../src/logger.ts";
import { runItem, type RunCtx } from "../src/loop.ts";
import { SimDriver, type SimFaults } from "./sim-driver.ts";

let server: ReturnType<typeof startReplica>;
let base = "";
const oracle = () => new Oracle(base);
const today = new Date(2026, 9, 3);

beforeAll(() => {
  server = startReplica(0); // any free port
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(async () => {
  await oracle().reset();
});

function ctxFor(driver: SimDriver, classifier: Classifier = new PolicyClassifier()): RunCtx {
  return {
    runId: "test",
    driver,
    agent: "Mint-3",
    classifier,
    oracle: oracle(),
    log: new RunLogger("test-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
    signal: new AbortController().signal,
    sleep: async () => {},
  };
}
const sim = (f: Partial<SimFaults> = {}) => new SimDriver({ serverBase: base, ...f });
const CLAIM = "Chan Tai Man, food, 128.50, 30/09/2026, FPS";

test("happy path: every field filled, read back, submitted, and verified by the form's database", async () => {
  const d = sim();
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d), item);
  expect(item.status).toBe("verified");
  expect(item.proof?.ok).toBe(true);
  const db = await oracle().all();
  expect(db).toHaveLength(1);
  expect(db[0]).toMatchObject({ payee: "Chan Tai Man", amount: "128.50", date: "30/09/2026", category: "Food", paidby: "FPS" });
  // the drop-down was filled with the proven recipe: click, Escape, type-ahead
  expect(d.calls.filter((c) => c.startsWith("key") || c.includes("category"))).toEqual(["click category", "key escape", 'type category "F"']);
  expect(item.counts.script + item.counts.foreground).toBe(0);
});

test("a dirty form is cleared first (typing would append, as measured live)", async () => {
  const d = sim({ prefill: { payee: "Stale Name" } });
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d), item);
  expect(item.status).toBe("verified");
  expect((await oracle().all())[0]!.payee).toBe("Chan Tai Man"); // not "Stale NameChan Tai Man"
  expect(d.calls[0]).toBe("click clear");
});

test("typing that is silently dropped ends as an exception, never a false done", async () => {
  const d = sim({ dropTypingFor: "amount" });
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d), item);
  expect(item.status).toBe("exception");
  expect(item.exception?.code).toBe("stalled");
  expect(await oracle().count()).toBe(0); // nothing was submitted
});

test("a wrong value is caught by the read-back; Submit is never pressed", async () => {
  const d = sim({ corruptTypingFor: "payee" });
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d), item);
  expect(item.status).toBe("exception");
  expect(item.exception?.code).toBe("field_mismatch");
  expect(d.calls.some((c) => c === "click submit")).toBe(false);
  expect(await oracle().count()).toBe(0);
});

class SaysDone implements Classifier {
  readonly backend = "jev" as const;
  async classify(): Promise<Decision> {
    return { kind: "done", kindP: { done: 0.99 }, kindConf: 0.98, gate: 0.98, backend: "jev", model: "stub", inputTokens: 900, ms: 1 };
  }
}
test("the classifier saying 'done' too early is caught by the oracle (false done)", async () => {
  const d = sim();
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d, new SaysDone()), item);
  expect(item.status).toBe("exception");
  expect(item.exception?.code).toBe("false_done");
  expect(item.counts.falseDoneCaught).toBe(1);
});

class Unsure implements Classifier {
  readonly backend = "jev" as const;
  async classify(_f: Facts, items: Item[]): Promise<Decision> {
    return { kind: "fill_field", item: items[0]!.i, field: "payee", kindP: { fill_field: 0.3 }, kindConf: 0.1, itemConf: 0.9, fieldConf: 0.9, gate: 0.1, backend: "jev", model: "stub", inputTokens: 900, ms: 1 };
  }
}
test("low confidence escalates instead of guessing", async () => {
  const d = sim();
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d, new Unsure()), item);
  expect(item.exception?.code).toBe("low_confidence");
  expect(d.calls).toEqual([]); // it never touched the form
});

class WrongControl implements Classifier {
  readonly backend = "jev" as const;
  async classify(_f: Facts, items: Item[]): Promise<Decision> {
    const amount = items.find((i) => i.text === "Amount (HKD)")!;
    return { kind: "fill_field", item: amount.i, field: "payee", kindP: { fill_field: 1 }, kindConf: 1, itemConf: 1, fieldConf: 1, gate: 1, backend: "jev", model: "stub", inputTokens: 900, ms: 1 };
  }
}
test("a control/value mismatch (payee value into the amount box) is refused before typing", async () => {
  const d = sim();
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d, new WrongControl()), item);
  expect(item.exception?.code).toBe("stalled");
  expect(d.calls.some((c) => c.startsWith("type"))).toBe(false);
});

test("a batch: verified claims, plus exceptions with reasons, nothing silent", async () => {
  const d = sim();
  const items = [
    newItem("1", "Chan Tai Man, food, 128.50, 30/09/2026, FPS", "seed", today),
    newItem("2", "Wong Ka Yan, venue, 1200, 02/10/2026, FPS", "seed", today), // over the mandate
    newItem("3", "Ho Mei, food, 66.80, last Fri, FPS", "seed", today), // ambiguous date
    newItem("4", "Chan Tai Man, food, 128.50, 30/09/2026, FPS", "seed", today), // duplicate of 1
    newItem("5", "Lee Siu Ming, transport, 42, 01/10/2026, Cash", "seed", today),
  ];
  const report = await runBatch(ctxFor(d), items);
  expect(report.verified.map((i) => i.id)).toEqual(["1", "5"]);
  expect(Object.fromEntries(report.exceptions.map((i) => [i.id, i.exception!.code]))).toEqual({
    "2": "over_mandate",
    "3": "unparseable_date",
    "4": "duplicate",
  });
  expect(report.verified.length + report.exceptions.length).toBe(items.length);
  expect(await oracle().count()).toBe(2);
  // only the two runnable claims touched the form
  expect(d.calls.filter((c) => c === "click submit")).toHaveLength(2);
});

test("stop: unfinished claims are reported as stopped, not dropped", async () => {
  const d = sim();
  const ac = new AbortController();
  const ctx = { ...ctxFor(d), signal: ac.signal };
  ac.abort();
  const items = [newItem("1", CLAIM, "typed", today)];
  const report = await runBatch(ctx, items);
  expect(report.exceptions[0]!.exception?.code).toBe("stopped");
});

class AlwaysSubmit implements Classifier {
  readonly backend = "jev" as const;
  async classify(_f: Facts, items: Item[]): Promise<Decision> {
    const b = items.find((i) => i.text === "Submit claim")!;
    return { kind: "submit", item: b.i, kindP: { submit: 1 }, kindConf: 1, gate: 1, backend: "jev", model: "stub", inputTokens: 900, ms: 1 };
  }
}
test("the submit guard blocks a classifier that presses Submit on an empty form", async () => {
  const d = sim();
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d, new AlwaysSubmit()), item);
  expect(item.status).toBe("exception");
  expect(item.counts.submitBlocked).toBeGreaterThanOrEqual(1);
  expect(d.calls.some((c) => c === "click submit")).toBe(false);
  expect(await oracle().count()).toBe(0);
});

// fills the payee (the sim corrupts it), then insists on submitting
class FillThenSubmit implements Classifier {
  readonly backend = "jev" as const;
  n = 0;
  async classify(_f: Facts, items: Item[]): Promise<Decision> {
    const mk = (kind: "fill_field" | "submit", text: string, field?: string): Decision => ({
      kind, item: items.find((i) => i.text === text)!.i, field, kindP: { [kind]: 1 }, kindConf: 1, itemConf: 1, fieldConf: 1, gate: 1, backend: "jev", model: "stub", inputTokens: 900, ms: 1,
    });
    return this.n++ === 0 ? mk("fill_field", "Payee name", "payee") : mk("submit", "Submit claim");
  }
}
test("a corrupted value never reaches Submit even if the classifier insists", async () => {
  const d = sim({ corruptTypingFor: "payee" });
  const item = newItem("c1", CLAIM, "typed", today);
  await runItem(ctxFor(d, new FillThenSubmit()), item);
  expect(d.calls.some((c) => c === "click submit")).toBe(false);
  expect(await oracle().count()).toBe(0);
  expect(item.status).toBe("exception");
});
