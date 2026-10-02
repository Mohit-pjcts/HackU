// Browser side of the brain: turns a captured frame into a model request in one of
// three pointing modes, and turns the answer back into frame pixels.
//
//   direct  - send the frame, ask for the target's bounding box.
//   grid    - draw a labelled grid on the frame, ask for a cell + position.
//   refine  - two passes: a first guess (direct or grid), then a zoomed crop of the
//             full-resolution frame around it, ask again inside the crop.
//
// "Frame" = the full-resolution captured image (for example 2880 x 1620 on a
// high-DPI laptop). Every point this module returns is in frame pixels; use
// frameToClient() from shared/geometry.js to place it on the page.
//
// Typical use from the app (Person A):
//   const result = await locate({ frame: canvas, step, transcript, mode: "refine", sessionId, history });
//   if (result.framePoint) drawRing(frameToClient(result.framePoint, result.frameSize.width, result.frameSize.height, rect));
//   speak(result.say);

import { fitSize, TIERS } from "./shared/budget.js";
import { cellLabel, cellRect, cropRegionAround, distance, GRID_DEFAULT } from "./shared/geometry.js";

const JPEG_QUALITY = 0.9; // small icons blur badly below ~0.85
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Server info and session
// ---------------------------------------------------------------------------

let serverInfo = null;

/** Reads /api/health once (cached). Falls back to the smaller standard budget if the server is unreachable. */
export async function getServerInfo({ force = false } = {}) {
  if (serverInfo && !force) return serverInfo;
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (!r.ok) throw new Error(`health ${r.status}`);
    serverInfo = await r.json();
    return serverInfo;
  } catch (e) {
    // Not cached: the next call tries again once the server is back.
    return { ok: false, error: String(e.message || e), imageBudget: TIERS.standard, imageBudgets: {}, allowedModels: [] };
  }
}

export function newSessionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `s-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Upload log: every image that leaves the device is listed here (time, size).
// The app shows a "capture sent" indicator by subscribing.
// ---------------------------------------------------------------------------

const uploadLog = [];
const uploadListeners = new Set();

export function onUpload(fn) {
  uploadListeners.add(fn);
  return () => uploadListeners.delete(fn);
}
export function getUploadLog() {
  return uploadLog.slice();
}
function noteUpload(entry) {
  uploadLog.push(entry);
  if (uploadLog.length > 500) uploadLog.shift();
  for (const fn of uploadListeners) {
    try { fn(entry); } catch { /* a broken listener must not break pointing */ }
  }
}

// ---------------------------------------------------------------------------
// Image preparation
// ---------------------------------------------------------------------------

export function sourceSize(src) {
  if (typeof HTMLVideoElement !== "undefined" && src instanceof HTMLVideoElement) return { width: src.videoWidth, height: src.videoHeight };
  if (typeof HTMLImageElement !== "undefined" && src instanceof HTMLImageElement) return { width: src.naturalWidth, height: src.naturalHeight };
  return { width: src.width, height: src.height };
}

function newCanvas(width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

/** Draw region `r` of `src` into a new canvas of size outW x outH. */
export function drawRegion(src, r, outW, outH) {
  const c = newCanvas(outW, outH);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, r.x, r.y, r.width, r.height, 0, 0, outW, outH);
  return c;
}

export async function encodeJpeg(canvas, quality = JPEG_QUALITY) {
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encoding failed"))), "image/jpeg", quality));
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
  return { base64: String(dataUrl).slice(String(dataUrl).indexOf(",") + 1), bytes: blob.size };
}

/**
 * Shrink a frame so the model never resizes it (see shared/budget.js).
 * Returns the canvas plus scaleX / scaleY = image pixels per frame pixel
 * (they differ by a fraction of a pixel because sizes are rounded separately).
 */
export function fitFrame(src, budget) {
  const { width, height } = sourceSize(src);
  const fit = fitSize(width, height, budget);
  const canvas = drawRegion(src, { x: 0, y: 0, width, height }, fit.width, fit.height);
  return { canvas, width: fit.width, height: fit.height, scaleX: fit.width / width, scaleY: fit.height / height };
}

/**
 * Draw the labelled grid used in grid mode, on a copy of `canvas`.
 * Bright lines with a dark outline stay visible on Photopea's dark UI and on photos.
 */
export function drawGrid(canvas, cols = GRID_DEFAULT.cols, rows = GRID_DEFAULT.rows) {
  const { width, height } = canvas;
  const c = newCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, 0, 0);

  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  const lines = () => {
    ctx.beginPath();
    for (let i = 1; i < cols; i += 1) {
      const x = Math.round((i * width) / cols) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    for (let j = 1; j < rows; j += 1) {
      const y = Math.round((j * height) / rows) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(width, y);
    }
    ctx.stroke();
  };
  lines();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,230,0,0.9)";
  lines();

  const cellW = width / cols;
  const cellH = height / rows;
  const fontPx = Math.max(10, Math.min(16, Math.round(Math.min(cellW, cellH) * 0.16)));
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const r = cellRect(col, row, cols, rows, width, height);
      const label = cellLabel(col, row);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(r.x1 + 2, r.y1 + 2, tw + 6, fontPx + 4);
      ctx.fillStyle = "#ffe600";
      ctx.fillText(label, r.x1 + 5, r.y1 + 4);
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// Server call
// ---------------------------------------------------------------------------

export class BrainError extends Error {
  constructor(code, message, { status = 0, say, retryAfterSec = 0, issues } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.say = say || "I couldn't reach my brain just now. Try again, or type what you see.";
    this.retryAfterSec = retryAfterSec;
    this.issues = issues;
  }
}

export async function callBrain(path, body, { accessCode, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (accessCode) headers["x-access-code"] = accessCode;
  try {
    const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    let json = null;
    try { json = await r.json(); } catch { /* non-JSON (e.g. a host error page) */ }
    if (!r.ok || !json?.ok) {
      throw new BrainError(json?.error?.code || `HTTP_${r.status}`, json?.error?.message || `Server answered ${r.status}`, {
        status: r.status, say: json?.say, retryAfterSec: Number(r.headers.get("Retry-After")) || 0, issues: json?.issues,
      });
    }
    return json;
  } catch (e) {
    if (e instanceof BrainError) throw e;
    if (e.name === "AbortError") {
      throw new BrainError(signal?.aborted ? "CANCELLED" : "CLIENT_TIMEOUT", "Request was cancelled or timed out", {
        say: signal?.aborted ? "" : "That took too long. Try again.",
      });
    }
    throw new BrainError("NETWORK", String(e.message || e), { say: "I can't reach the internet right now. Type what you see, or try again." });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function stepFields(step) {
  return {
    stepId: step.id ?? step.stepId,
    stepGoal: step.goal ?? step.stepGoal,
    targetHint: step.targetHint ?? "",
    commonMistakes: (step.commonMistakes || []).slice(0, 6),
  };
}

async function sendImage({ canvas, mode, extra, step, transcript, sessionId, history, model, accessCode, signal, onSend }) {
  const { base64, bytes } = await encodeJpeg(canvas);
  onSend?.({ canvas, mode, extra, bytes });
  const body = {
    sessionId, ...stepFields(step), transcript: transcript || "", history: history || [],
    imageBase64: base64, imageWidth: canvas.width, imageHeight: canvas.height, mode, ...extra,
  };
  if (model) body.model = model;
  noteUpload({ at: new Date().toISOString(), kind: "step", mode, bytes, width: canvas.width, height: canvas.height, transcriptChars: body.transcript.length });
  return callBrain("/api/step", body, { accessCode, signal });
}

// ---------------------------------------------------------------------------
// locate(): run one pointing mode end to end
// ---------------------------------------------------------------------------

const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0 });

function addUsage(total, r) {
  total.inputTokens += r.usage?.inputTokens || 0;
  total.outputTokens += r.usage?.outputTokens || 0;
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement|HTMLVideoElement|ImageBitmap|HTMLImageElement} o.frame  full-resolution capture
 * @param {{id, goal, targetHint?, commonMistakes?}} o.step
 * @param {"direct"|"grid"|"refine"} [o.mode]
 * @param {"direct"|"grid"} [o.firstPass]  first pass used by refine
 * @param {{cols, rows}} [o.grid]
 * @param {number} [o.maxZoom]  refine: largest upscale of the crop
 * @param {function} [o.onSend]  debug hook, called with { canvas, mode, extra, bytes } for every image sent
 * @returns {Promise<object>} see README in docs/brain.md ("locate() result")
 */
export async function locate(o) {
  const {
    frame, step, transcript = "", mode = "direct", sessionId, history = [], model, accessCode, signal,
    firstPass = "direct", grid = GRID_DEFAULT, maxZoom = 3, onSend,
  } = o;
  if (!sessionId) throw new Error("locate: sessionId is required (use newSessionId())");
  const started = performance.now();
  const info = await getServerInfo();
  const budget = (model && info.imageBudgets?.[model]) || info.imageBudget || TIERS.standard;
  const frameSize = sourceSize(frame);
  const usage = emptyUsage();
  let costUsd = 0;
  let costKnown = true;
  const passes = [];
  const common = { step, transcript, sessionId, history, model, accessCode, signal, onSend };

  const track = (r) => {
    passes.push(r);
    addUsage(usage, r);
    if (typeof r.costUsd === "number") costUsd += r.costUsd;
    else costKnown = false;
  };

  // --- Pass 1 (direct or grid) on the whole frame ---
  const p1Mode = mode === "refine" ? firstPass : mode;
  const fitted = fitFrame(frame, budget);
  let p1Canvas = fitted.canvas;
  const extra = {};
  if (p1Mode === "grid") {
    p1Canvas = drawGrid(fitted.canvas, grid.cols, grid.rows);
    extra.gridCols = grid.cols;
    extra.gridRows = grid.rows;
  }
  const r1 = await sendImage({ canvas: p1Canvas, mode: p1Mode, extra, ...common });
  track(r1);
  const toFrame = (p) => (p ? { x: p.x / fitted.scaleX, y: p.y / fitted.scaleY } : null);
  const boxToFrame = (b) => (b ? [b[0] / fitted.scaleX, b[1] / fitted.scaleY, b[2] / fitted.scaleX, b[3] / fitted.scaleY] : null);

  const result = {
    mode,
    say: r1.say,
    cannotTell: r1.cannotTell,
    confidence: r1.confidence,
    offTrack: r1.offTrack,
    observation: r1.observation,
    reason: r1.reason,
    framePoint: toFrame(r1.target),
    frameBox: boxToFrame(r1.targetBox),
    modelGuess: toFrame(r1.modelTarget), // even when cannotTell: for evaluation only, never draw it
    frameSize,
    refined: false,
    agreementPx: null,
    passes,
  };

  // --- Pass 2 (refine): zoom into the full-resolution frame around the first guess ---
  // A low-confidence first guess is still worth zooming into: the second look may confirm it.
  // A first pass that says "not visible" is not: there is nothing to zoom into.
  const seed = r1.target || (r1.reason === "below_confidence_floor" ? r1.modelTarget : null);
  const coarse = toFrame(seed);
  if (mode === "refine" && coarse && !signal?.aborted) {
    const regionW = Math.round(Math.min(frameSize.width, Math.max(320, frameSize.width * 0.25)));
    const regionH = Math.round(Math.min(frameSize.height, regionW * 0.625));
    const region = cropRegionAround(coarse, frameSize.width, frameSize.height, regionW, regionH);
    const zoomFit = fitSize(region.width * maxZoom, region.height * maxZoom, budget);
    const cropCanvas = drawRegion(frame, region, zoomFit.width, zoomFit.height);
    const cropScale = zoomFit.width / region.width; // crop pixels per frame pixel

    let r2 = null;
    try {
      r2 = await sendImage({
        canvas: cropCanvas, mode: "refine", extra: { cropOffsetX: region.x, cropOffsetY: region.y, cropScale }, ...common,
      });
      track(r2);
    } catch (e) {
      // A failed second look must not throw away a good first answer.
      if (e.code === "CANCELLED") throw e;
      result.refineError = e.code || "ERROR";
    }
    if (r2 && r2.frameTarget && !r2.cannotTell) {
      result.refined = true;
      result.framePoint = r2.frameTarget;
      result.frameBox = r2.frameBox;
      result.say = r2.say;
      result.cannotTell = false;
      result.reason = null;
      result.offTrack = r2.offTrack;
      result.confidence = r2.confidence;
      result.observation = r2.observation;
      result.agreementPx = Math.round(distance(coarse, r2.frameTarget));
    }
    // If the second pass cannot find it in the crop, we keep the first answer (refined = false)
    // and flag it: the evaluation can then show whether such pointers should be withheld.
    if (r2 && !result.refined) result.refineMissed = true;
  }

  result.calls = passes.length;
  result.usage = usage;
  result.costUsd = costKnown ? Math.round(costUsd * 1e6) / 1e6 : null;
  result.latencyMs = Math.round(performance.now() - started);
  return result;
}

/**
 * Ask the model whether a step is finished (the "model-checked" fallback).
 * @returns {Promise<{done: boolean|null, say, confidence, ...}>}
 */
export async function verifyStep({ frame, step, sessionId, model, accessCode, signal }) {
  const info = await getServerInfo();
  const budget = (model && info.imageBudgets?.[model]) || info.imageBudget || TIERS.standard;
  const { canvas } = fitFrame(frame, budget);
  const { base64, bytes } = await encodeJpeg(canvas);
  const s = stepFields(step);
  const body = {
    sessionId, stepId: s.stepId, stepGoal: s.stepGoal, doneWhen: step.check?.doneWhen || step.doneWhen || s.stepGoal,
    imageBase64: base64, imageWidth: canvas.width, imageHeight: canvas.height,
  };
  if (model) body.model = model;
  noteUpload({ at: new Date().toISOString(), kind: "verify", mode: null, bytes, width: canvas.width, height: canvas.height, transcriptChars: 0 });
  return callBrain("/api/verify", body, { accessCode, signal });
}
