import { test } from "node:test";
import assert from "node:assert/strict";
import { fitSize, fitsBudget, tierForModel, TIERS, visualTokens } from "../src/shared/budget.js";

test("visual tokens match Anthropic's formula", () => {
  assert.equal(visualTokens(1920, 1080), 69 * 39); // 2691, the figure quoted in the build guide
  assert.equal(visualTokens(28, 28), 1);
  assert.equal(visualTokens(29, 28), 2);
});

test("a 1920x1080 frame fits the high tier untouched", () => {
  assert.deepEqual(fitSize(1920, 1080, TIERS.high), { width: 1920, height: 1080, scale: 1 });
});

test("4K and HiDPI frames are shrunk to fit both limits, keeping the aspect ratio", () => {
  for (const [w, h] of [[3840, 2160], [2880, 1800], [2560, 1600], [5120, 2880], [1366, 768], [3000, 400], [400, 3000]]) {
    for (const tier of [TIERS.high, TIERS.standard]) {
      const f = fitSize(w, h, tier);
      assert.ok(fitsBudget(f.width, f.height, tier), `${w}x${h} -> ${f.width}x${f.height} must fit ${tier.name}`);
      assert.ok(Math.abs(f.width / f.height - w / h) < 0.02, "aspect ratio kept");
      assert.ok(f.width <= w && f.height <= h, "never upscales");
      // Not wastefully small: within ~3% of the token budget or at the edge limit.
      const used = visualTokens(f.width, f.height) / tier.maxTokens;
      assert.ok(used > 0.9 || Math.max(f.width, f.height) > tier.maxEdge * 0.97 || f.scale === 1, `${w}x${h} uses ${used}`);
    }
  }
});

test("model tiers: 5.x and 4.7+ are high resolution, Haiku and unknown models are standard", () => {
  assert.equal(tierForModel("claude-sonnet-5-5"), TIERS.high);
  assert.equal(tierForModel("claude-opus-5-5"), TIERS.high);
  assert.equal(tierForModel("claude-fable-5-1"), TIERS.high);
  assert.equal(tierForModel("claude-haiku-4-5-20251001"), TIERS.standard);
  assert.equal(tierForModel("some-new-model"), TIERS.standard);
});
