// One function that sends an image plus text to Claude and returns parsed JSON.
//
// Why structured outputs (output_config.format) and not a forced tool call:
// Opus 5.5 and Fable 5.1 have adaptive thinking always on, and Sonnet 5.5 has it on
// by default. Anthropic's structured-outputs page (read 2 Oct 2026) says JSON-schema
// output is compatible with thinking and with images, so the same code works for
// every model in the bake-off. We still validate the JSON ourselves afterwards.

import Anthropic from "@anthropic-ai/sdk";

export class ModelError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let cachedClient = null;
let cachedKey = null;

function defaultClient(cfg) {
  if (!cfg.apiKey) throw new ModelError("NO_API_KEY", "ANTHROPIC_API_KEY is not set on the server", 500);
  if (!cachedClient || cachedKey !== cfg.apiKey) {
    cachedClient = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 1, timeout: cfg.timeoutMs });
    cachedKey = cfg.apiKey;
  }
  return cachedClient;
}

/** Build the exact request body. Exported so tests can check its shape. */
export function buildRequest({ model, system, image, text, schema, cfg, effort }) {
  const outputConfig = { format: { type: "json_schema", schema } };
  if (effort) outputConfig.effort = effort;
  const body = {
    model,
    max_tokens: cfg.maxOutputTokens,
    system,
    messages: [
      {
        role: "user",
        content: [
          // Image first, then text (Anthropic's vision guidance).
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
            // Fail loudly instead of silently resizing, which would shift every coordinate.
            transformations: { oversized_image: "error" },
          },
          { type: "text", text },
        ],
      },
    ],
    output_config: outputConfig,
  };
  if (cfg.thinking) body.thinking = { type: cfg.thinking };
  return body;
}

function mapApiError(err) {
  const status = err?.status;
  const msg = String(err?.error?.error?.message || err?.message || "model call failed");
  if (err?.name === "APIConnectionTimeoutError" || /timed? ?out/i.test(msg)) {
    return new ModelError("MODEL_TIMEOUT", "The model took too long to answer.", 504);
  }
  if (status === 400 && /image|resiz|oversiz|dimension/i.test(msg)) {
    return new ModelError("IMAGE_REJECTED", `The model rejected the image: ${msg.slice(0, 200)}`, 400);
  }
  if (status === 401 || status === 403) return new ModelError("MODEL_AUTH", "The server's API key was rejected.", 502);
  if (status === 404) return new ModelError("MODEL_NOT_FOUND", "The configured model name was not found.", 502);
  if (status === 429) return new ModelError("MODEL_RATE_LIMITED", "The model provider is rate limiting us.", 503);
  if (status === 529 || status >= 500) return new ModelError("MODEL_BUSY", "The model provider is busy.", 503);
  return new ModelError("MODEL_ERROR", msg.slice(0, 200), 502);
}

/**
 * Call the model and return { data, usage, stopReason, model }.
 * `data` is the parsed JSON object, or null if the reply was not valid JSON
 * (the caller then answers "I can't tell").
 */
export async function callModel({ model, system, image, text, schema, cfg, client }) {
  const api = client || defaultClient(cfg);
  let effort = cfg.effort;
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await api.messages.create(buildRequest({ model, system, image, text, schema, cfg, effort }));
      break;
    } catch (err) {
      const msg = String(err?.error?.error?.message || err?.message || "");
      // Some models may not accept an effort level; retry once without it rather than fail the user.
      if (attempt === 0 && err?.status === 400 && effort && /effort/i.test(msg)) {
        console.warn(JSON.stringify({ event: "effort_rejected_retrying", model, effort }));
        effort = null;
        continue;
      }
      throw mapApiError(err);
    }
  }

  const usage = {
    inputTokens: response?.usage?.input_tokens ?? 0,
    outputTokens: response?.usage?.output_tokens ?? 0,
  };
  const textBlock = (response?.content || []).find((b) => b.type === "text");
  let data = null;
  if (textBlock && response.stop_reason !== "max_tokens" && response.stop_reason !== "refusal") {
    try {
      data = JSON.parse(textBlock.text);
    } catch {
      data = null;
    }
  }
  return { data, usage, stopReason: response?.stop_reason ?? null, model: response?.model || model };
}

// ---------------------------------------------------------------------------
// Mock model: lets the front end, the test page and the tests run with no API key.
// It does not look at the image. It points at the left toolbar, and answers
// "can't tell" when the user's words contain "blank".
// ---------------------------------------------------------------------------
export async function mockModel({ kind, req, size }) {
  await new Promise((r) => setTimeout(r, 150));
  const usage = { inputTokens: 0, outputTokens: 0 };
  const blank = /blank|nothing/i.test(req.transcript || "");
  if (kind === "verify") {
    return {
      data: { observation: "Mock answer.", done: blank ? "cannot_tell" : "yes", say: "Mock: looks done.", confidence: 0.7 },
      usage, stopReason: "end_turn", model: "mock",
    };
  }
  if (blank) {
    return {
      data: {
        observation: "Mock: pretending the screen is blank.", targetVisible: false,
        ...(req.mode === "grid" ? { cell: null, position: null } : { box: null }),
        offTrack: false, say: "I can't see the editor. What is on your screen?", confidence: 0.1,
      },
      usage, stopReason: "end_turn", model: "mock",
    };
  }
  const location =
    req.mode === "grid"
      ? { cell: "A3", position: "left" }
      : { box: [Math.round(size.width * 0.005), Math.round(size.height * 0.2), Math.round(size.width * 0.02), Math.round(size.height * 0.23)] };
  return {
    data: {
      observation: "Mock: the editor is open.", targetVisible: true, ...location, offTrack: false,
      say: "Mock answer: click the highlighted tool in the left toolbar.", confidence: 0.8,
    },
    usage, stopReason: "end_turn", model: "mock",
  };
}
