// Small helpers shared by the API functions. Works with Vercel's Node.js runtime
// (req.body already parsed) and with our dev-server.mjs (we read the stream).

import { timingSafeEqual, createHash } from "node:crypto";

export const MAX_BODY_BYTES = 4_500_000;

export function sendJson(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** Every failure has the same shape, and always carries something the buddy can say. */
export function sendError(res, status, code, message, { say, headers = {}, body = {} } = {}) {
  sendJson(
    res,
    status,
    { ok: false, error: { code, message }, say: say || "Something went wrong on my side. Try again, or type what you see.", ...body },
    headers,
  );
}

export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  let raw;
  if (typeof req.body === "string") raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const e = new Error("body too large");
        e.code = "BODY_TOO_LARGE";
        throw e;
      }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error("body is not valid JSON");
    e.code = "BAD_JSON";
    throw e;
  }
}

/** Constant-time comparison of the access code (when one is configured). */
export function accessAllowed(req, expected) {
  if (!expected) return true;
  const given = String(req.headers?.["x-access-code"] || "");
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Session IDs are logged only as a short hash, so logs cannot be joined back to a visitor. */
export function shortHash(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 10);
}

/**
 * One JSON line per call. Deliberately no image, no transcript text and no IP:
 * only sizes, timings, tokens and outcome. This is what the README's
 * "what leaves the device / what we keep" section promises.
 */
export function logCall(fields) {
  console.log(JSON.stringify({ event: "model_call", at: new Date().toISOString(), ...fields }));
}
