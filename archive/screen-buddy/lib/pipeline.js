// The request pipeline shared by /api/step and /api/verify:
// method -> access code -> body -> validation -> image checks -> limits -> model -> checks on the answer.
// Cheap checks run first so a bad request never costs a model call.

import { getConfig } from "./config.js";
import { accessAllowed, logCall, readJsonBody, sendError, sendJson, shortHash } from "./http.js";
import { decodeBase64Image, ImageError, imageInfo } from "./imageinfo.js";
import { interpretPointing, interpretVerify } from "./interpret.js";
import { callModel, mockModel, ModelError } from "./model.js";
import { costUsd, PRICES_READ_ON } from "./pricing.js";
import {
  buildUserText, buildVerifyText, outputSchema, SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT, verifySchema,
} from "./prompt.js";
import { clientIp, takeCall } from "./ratelimit.js";
import { stepRequestSchema, validate, verifyRequestSchema } from "./validate.js";
import { fitsBudget, visualTokens } from "../src/shared/budget.js";
import { cropBoxToFrame, cropToFrame, GRID_DEFAULT } from "../src/shared/geometry.js";

const KINDS = {
  step: { schema: stepRequestSchema },
  verify: { schema: verifyRequestSchema },
};

/**
 * @param {"step"|"verify"} kind
 * @param {{ client?: object }} deps  injectable Anthropic client (tests)
 */
export function createHandler(kind, deps = {}) {
  const { schema } = KINDS[kind];

  // Outer guard: whatever happens, the page gets JSON with something to say, never an HTML error page.
  return async function handler(req, res) {
    try {
      return await handle(req, res);
    } catch (e) {
      console.error(JSON.stringify({ event: "unhandled_error", kind, message: String(e?.message || e) }));
      if (!res.headersSent) return sendError(res, 500, "INTERNAL", "Unexpected server error.");
    }
  };

  async function handle(req, res) {
    const started = Date.now();
    const cfg = getConfig();

    if (req.method !== "POST") {
      return sendError(res, 405, "METHOD_NOT_ALLOWED", "Use POST.", { headers: { Allow: "POST" } });
    }
    if (!accessAllowed(req, cfg.accessCode)) {
      return sendError(res, 401, "ACCESS_CODE", "Missing or wrong access code.", {
        say: "This demo needs an access code. Ask the team at the booth.",
      });
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      if (e.code === "BODY_TOO_LARGE") return sendError(res, 413, "BODY_TOO_LARGE", "Request body is over 4.5 MB. Send a smaller JPEG.");
      return sendError(res, 400, "BAD_JSON", "Request body is not valid JSON.");
    }

    const v = validate(schema, body);
    if (!v.ok) return sendError(res, 400, "BAD_REQUEST", "Request failed validation.", { body: { issues: v.issues } });
    const r = v.data;

    const model = r.model || cfg.model;
    if (!cfg.allowedModels.includes(model)) {
      return sendError(res, 400, "MODEL_NOT_ALLOWED", `Model ${model} is not in ALLOWED_MODELS.`);
    }

    // --- Image checks: real type, real size, and the model's resize budget ---
    let image;
    try {
      const buf = decodeBase64Image(r.imageBase64);
      const info = imageInfo(buf);
      if (info.width !== r.imageWidth || info.height !== r.imageHeight) {
        return sendError(res, 400, "IMAGE_SIZE_MISMATCH",
          `imageWidth/imageHeight say ${r.imageWidth}x${r.imageHeight} but the image is ${info.width}x${info.height}.`);
      }
      image = { ...info, base64: r.imageBase64 };
    } catch (e) {
      if (e instanceof ImageError) return sendError(res, 400, e.code, e.message);
      throw e;
    }
    const tier = cfg.tierFor(model);
    if (!fitsBudget(image.width, image.height, tier)) {
      return sendError(res, 400, "IMAGE_TOO_LARGE",
        `Image is ${image.width}x${image.height} (${visualTokens(image.width, image.height)} visual tokens); ` +
        `${model} takes at most ${tier.maxEdge}px on the long edge and ${tier.maxTokens} tokens. Resize on the page first.`,
        { body: { imageBudget: tier } });
    }

    if (!cfg.mock && !cfg.apiKey) {
      return sendError(res, 500, "NO_API_KEY", "The server has no ANTHROPIC_API_KEY.", {
        say: "My brain isn't connected yet. The team needs to add the API key.",
      });
    }

    if (kind === "step" && r.mode === "grid") {
      r.gridCols = r.gridCols ?? GRID_DEFAULT.cols;
      r.gridRows = r.gridRows ?? GRID_DEFAULT.rows;
    }

    // --- Limits: only counted once the request is known to be well-formed ---
    const limit = takeCall({ ip: clientIp(req), sessionId: r.sessionId, cfg });
    if (!limit.ok) {
      return sendError(res, 429, limit.code, limit.message, {
        say: limit.code === "SESSION_CAP" ? limit.message : "I need a short break. Try again in a moment.",
        headers: limit.retryAfterSec ? { "Retry-After": String(limit.retryAfterSec) } : {},
      });
    }

    // --- Model call ---
    const size = { width: image.width, height: image.height };
    const modelStarted = Date.now();
    let result;
    try {
      if (cfg.mock) {
        result = await mockModel({ kind, req: r, size });
      } else if (kind === "verify") {
        result = await callModel({
          model, system: VERIFY_SYSTEM_PROMPT, image, text: buildVerifyText(r, size), schema: verifySchema(), cfg, client: deps.client,
        });
      } else {
        result = await callModel({
          model, system: SYSTEM_PROMPT, image, text: buildUserText(r, size), schema: outputSchema(r.mode), cfg, client: deps.client,
        });
      }
    } catch (e) {
      const err = e instanceof ModelError ? e : new ModelError("MODEL_ERROR", "Unexpected error calling the model.", 502);
      logCall({
        kind, mode: r.mode, stepId: r.stepId, session: shortHash(r.sessionId), model, ok: false, error: err.code,
        imageBytes: image.bytes, width: image.width, height: image.height, latencyMs: Date.now() - started,
      });
      if (!(e instanceof ModelError)) console.error(e);
      return sendError(res, err.status || 502, err.code, err.message, {
        say: err.code === "MODEL_TIMEOUT" ? "That took too long. Try again." : undefined,
      });
    }
    const modelLatencyMs = Date.now() - modelStarted;

    const usage = result.usage;
    const cost = cfg.mock ? 0 : costUsd(model, usage.inputTokens, usage.outputTokens);
    const out = kind === "verify"
      ? interpretVerify(result.data)
      : interpretPointing(result.data, r, size, cfg.confidenceFloor);

    const payload = {
      ok: true,
      ...out,
      ...(kind === "step" ? { mode: r.mode, image: size } : {}),
      model: cfg.mock ? "mock" : model,
      mock: cfg.mock,
      usage,
      costUsd: cost,
      pricesReadOn: PRICES_READ_ON,
      latencyMs: Date.now() - started,
      modelLatencyMs,
      stopReason: result.stopReason,
      // A receipt of exactly what reached the server, so the page can show "what left your device".
      received: {
        imageBytes: image.bytes,
        imageWidth: image.width,
        imageHeight: image.height,
        transcriptChars: kind === "step" ? (r.transcript || "").length : 0,
        stored: false,
      },
      callsLeft: limit.callsLeft,
    };

    // Refine mode: also give the answer in full-frame pixels so callers need not redo the maths.
    if (kind === "step" && r.mode === "refine") {
      payload.crop = { cropOffsetX: r.cropOffsetX, cropOffsetY: r.cropOffsetY, cropScale: r.cropScale };
      payload.frameTarget = out.target ? cropToFrame(out.target, r.cropOffsetX, r.cropOffsetY, r.cropScale) : null;
      payload.frameBox = out.targetBox ? cropBoxToFrame(out.targetBox, r.cropOffsetX, r.cropOffsetY, r.cropScale) : null;
    }

    logCall({
      kind, mode: r.mode ?? null, stepId: r.stepId, session: shortHash(r.sessionId), model: payload.model, ok: true,
      cannotTell: out.cannotTell ?? null, done: out.done ?? null, reason: out.reason, confidence: out.confidence,
      imageBytes: image.bytes, width: image.width, height: image.height,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: cost,
      latencyMs: payload.latencyMs, modelLatencyMs, stopReason: result.stopReason,
    });

    return sendJson(res, 200, payload);
  }
}
