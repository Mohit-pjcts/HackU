import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, callModel, ModelError } from "../lib/model.js";
import { outputSchema } from "../lib/prompt.js";

const cfg = { apiKey: "x", maxOutputTokens: 2000, timeoutMs: 1000, effort: "low", thinking: null };
const image = { mediaType: "image/jpeg", base64: "AAAA" };

test("request puts the image first, forbids silent resizing and asks for schema JSON", () => {
  const body = buildRequest({ model: "claude-sonnet-5-5", system: "sys", image, text: "where?", schema: outputSchema("direct"), cfg, effort: "low" });
  const [img, txt] = body.messages[0].content;
  assert.equal(img.type, "image");
  assert.deepEqual(img.transformations, { oversized_image: "error" });
  assert.equal(txt.type, "text");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.ok(!("thinking" in body));
  assert.ok(!("tool_choice" in body));
});

test("every schema property is required (structured outputs needs this)", () => {
  for (const mode of ["direct", "grid", "refine"]) {
    const s = outputSchema(mode);
    assert.deepEqual(s.required.sort(), Object.keys(s.properties).sort());
  }
});

function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(body) {
        calls.push(body);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const reply = (text, extra = {}) => ({
  content: [{ type: "thinking", thinking: "..." }, { type: "text", text }],
  usage: { input_tokens: 1500, output_tokens: 120 }, stop_reason: "end_turn", model: "claude-sonnet-5-5", ...extra,
});

test("parses the JSON text block after a thinking block and reports usage", async () => {
  const client = fakeClient([reply('{"a":1}')]);
  const r = await callModel({ model: "claude-sonnet-5-5", system: "s", image, text: "t", schema: {}, cfg, client });
  assert.deepEqual(r.data, { a: 1 });
  assert.deepEqual(r.usage, { inputTokens: 1500, outputTokens: 120 });
});

test("non-JSON or truncated replies give data = null (the caller then says it can't tell)", async () => {
  const client = fakeClient([reply("Sure! Click the wand."), reply('{"a":', { stop_reason: "max_tokens" })]);
  assert.equal((await callModel({ model: "m", system: "s", image, text: "t", schema: {}, cfg, client })).data, null);
  assert.equal((await callModel({ model: "m", system: "s", image, text: "t", schema: {}, cfg, client })).data, null);
});

test("retries once without effort if the model rejects the effort setting", async () => {
  const err = Object.assign(new Error("400 effort not supported"), { status: 400 });
  const client = fakeClient([err, reply('{"ok":true}')]);
  const r = await callModel({ model: "m", system: "s", image, text: "t", schema: {}, cfg, client });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(client.calls[0].output_config.effort, "low");
  assert.equal(client.calls[1].output_config.effort, undefined);
});

test("API errors map to clear codes", async () => {
  const cases = [
    [{ status: 401, message: "invalid x-api-key" }, "MODEL_AUTH"],
    [{ status: 404, message: "model not found" }, "MODEL_NOT_FOUND"],
    [{ status: 429, message: "rate limited" }, "MODEL_RATE_LIMITED"],
    [{ status: 529, message: "overloaded" }, "MODEL_BUSY"],
    [{ status: 400, message: "image exceeds the maximum dimensions and would be resized" }, "IMAGE_REJECTED"],
    [{ name: "APIConnectionTimeoutError", message: "Request timed out." }, "MODEL_TIMEOUT"],
  ];
  for (const [shape, code] of cases) {
    const client = fakeClient([Object.assign(new Error(shape.message), shape)]);
    await assert.rejects(callModel({ model: "m", system: "s", image, text: "t", schema: {}, cfg: { ...cfg, effort: null }, client }),
      (e) => e instanceof ModelError && e.code === code);
  }
});
