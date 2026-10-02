import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretPointing, interpretVerify } from "../lib/interpret.js";

const size = { width: 1200, height: 800 };
const direct = { mode: "direct" };
const ok = (over = {}) => ({
  observation: "Editor open.", targetVisible: true, box: [10, 100, 40, 130], offTrack: false, say: "Click the wand.", confidence: 0.9, ...over,
});

test("a confident box becomes a pointer at its centre", () => {
  const r = interpretPointing(ok(), direct, size, 0.5);
  assert.equal(r.cannotTell, false);
  assert.deepEqual(r.target, { x: 25, y: 115 });
  assert.deepEqual(r.targetBox, [10, 100, 40, 130]);
  assert.equal(r.say, "Click the wand.");
});

test("below the confidence floor: no pointer, honest wording, guess kept for evaluation", () => {
  const r = interpretPointing(ok({ confidence: 0.3 }), direct, size, 0.5);
  assert.equal(r.cannotTell, true);
  assert.equal(r.target, null);
  assert.deepEqual(r.modelTarget, { x: 25, y: 115 });
  assert.equal(r.reason, "below_confidence_floor");
  assert.match(r.say, /not sure/i);
});

test("model says not visible -> can't tell, keeps the model's own description", () => {
  const r = interpretPointing(ok({ targetVisible: false, box: null, say: "I see a blank white page." }), direct, size, 0.5);
  assert.equal(r.cannotTell, true);
  assert.equal(r.reason, "model_says_not_visible");
  assert.equal(r.say, "I see a blank white page.");
});

test("garbage, missing fields or impossible boxes never produce a pointer", () => {
  for (const bad of [null, "text", {}, ok({ box: [5000, 5000, 5100, 5100] }), ok({ box: [1, 2] }), ok({ confidence: "high" })]) {
    const r = interpretPointing(bad, direct, size, 0.5);
    assert.equal(r.cannotTell, true, JSON.stringify(bad));
    assert.equal(r.target, null);
  }
});

test("grid answers are converted from cell to pixels", () => {
  const req = { mode: "grid", gridCols: 12, gridRows: 8 };
  const r = interpretPointing(ok({ box: undefined, cell: "A2", position: "center" }), req, size, 0.5);
  assert.deepEqual(r.target, { x: 50, y: 150 });
  const bad = interpretPointing(ok({ box: undefined, cell: "Q2", position: "center" }), req, size, 0.5);
  assert.equal(bad.reason, "invalid_cell");
});

test("confidence is clamped and long speech is trimmed", () => {
  const r = interpretPointing(ok({ confidence: 7, say: "x".repeat(1000) }), direct, size, 0.5);
  assert.equal(r.confidence, 1);
  assert.ok(r.say.length <= 300);
});

test("verify answers map to true / false / null", () => {
  assert.equal(interpretVerify({ observation: "", done: "yes", say: "Done.", confidence: 0.8 }).done, true);
  assert.equal(interpretVerify({ observation: "", done: "no", say: "Not yet.", confidence: 0.8 }).done, false);
  assert.equal(interpretVerify({ observation: "", done: "cannot_tell", say: "?", confidence: 0.2 }).done, null);
  assert.equal(interpretVerify("nonsense").done, null);
});
