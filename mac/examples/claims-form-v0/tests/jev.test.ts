import { expect, test } from "bun:test";
import { FallbackClassifier, JevClassifier, PolicyClassifier, gateFor } from "../src/decide.ts";
import type { Facts, Item } from "../src/contracts.ts";

const items: Item[] = [
  { i: 0, id: "AXTextField:Payee name", text: "Payee name", role: "AXTextField", token: "t0", state: "empty", where: "top" },
  { i: 1, id: "AXTextField:Amount (HKD)", text: "Amount (HKD)", role: "AXTextField", token: "t1", state: "empty", where: "top" },
  { i: 2, id: "AXButton:Submit claim", text: "Submit claim", role: "AXButton", token: "t2", state: "n/a", where: "bottom" },
];
const facts: Facts = {
  goal: "Enter this claim",
  claim: { payee: "Chan Tai Man", amount: "128.50", date: "30/09/2026", category: "Food", paidBy: "FPS" },
  filled: { payee: "empty", amount: "empty", date: "empty", category: "empty", paidBy: "empty" },
  previousActions: [],
  alreadyTriedHere: [],
};
const reply = (model: string) => ({
  model,
  answers: {
    kind: { type: "choice", choice: "fill_field", probabilities: { fill_field: 0.9, submit: 0.1 }, confidence: 0.85 },
    item: { type: "choice", choice: "0", probabilities: { "0": 0.95, "1": 0.05 }, confidence: 0.9 },
    field: { type: "choice", choice: "payee", probabilities: { payee: 0.96, none: 0.04 }, confidence: 0.92 },
  },
  usage: { input_tokens: 812, output_tokens: 0 },
});

test("sends 3 typed questions and maps the answers to a decision", async () => {
  let sent: any;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(reply("jev-1.13.0")), { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_1" } });
  }) as unknown as typeof fetch;
  const d = await new JevClassifier("jev-1.13.0", { apiKey: "sk-fake", fetch: fakeFetch }).classify(facts, items);

  expect(Object.keys(sent.questions).sort()).toEqual(["field", "item", "kind"]);
  expect(sent.model).toBe("jev-1.13.0");
  expect(Object.keys(sent.questions.item.criteria)).toEqual(["0", "1", "2"]);
  expect(sent.questions.item.criteria["0"]).toContain("Payee name");
  expect(sent.questions.field.criteria.payee).toContain("Chan Tai Man"); // the claim value is shown, so matching control<->value is possible
  expect(Object.keys(sent.questions.kind.criteria)).toEqual(["fill_field", "click_item", "submit", "clear_form", "wait", "done", "none"]);
  expect(JSON.stringify(sent.state)).not.toContain("undefined");

  expect(d).toMatchObject({ kind: "fill_field", item: 0, field: "payee", backend: "jev", inputTokens: 812, requestId: "req_1" });
  expect(d.gate).toBeCloseTo(0.85); // min(kind .85, item .90, field .92)
});

test("a pinned model the account can't use falls back to jev-latest once", async () => {
  const models: string[] = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    models.push(body.model);
    if (body.model === "jev-1.13.0") return new Response(JSON.stringify({ error: "model not found" }), { status: 422, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(reply("jev-1.14.0")), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const d = await new JevClassifier("jev-1.13.0", { apiKey: "sk-fake", fetch: fakeFetch }).classify(facts, items);
  expect(models).toEqual(["jev-1.13.0", "jev-latest"]);
  expect(d.model).toBe("jev-1.14.0");
});

test("when TypeSafe is down the labelled policy decides, never silently", async () => {
  const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
  const fb = new FallbackClassifier(new JevClassifier("jev-1.13.0", { apiKey: "sk-fake", fetch: down }), new PolicyClassifier());
  const d = await fb.classify(facts, items);
  expect(d.backend).toBe("policy");
  expect(fb.degraded).toBe(true);
  expect(fb.lastError.length).toBeGreaterThan(0);
  expect(d).toMatchObject({ kind: "fill_field", field: "payee", item: 0 });
});

test("the gate uses only the questions that matter for the kind", () => {
  expect(gateFor("fill_field", 0.9, 0.5, 0.7)).toBe(0.5);
  expect(gateFor("click_item", 0.9, 0.5, 0.1)).toBe(0.5);
  expect(gateFor("submit", 0.9, 0.1, 0.1)).toBe(0.9);
});
