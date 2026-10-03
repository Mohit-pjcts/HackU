// Step checks: did the user's step actually work? Answered from document facts,
// not from guessing at pixels. Order of preference (build guide 4.5):
//   1. script  - ask Photopea about the document (layers, size, selection, history)
//   2. pixels  - export a small PNG of the document and measure it in the page
//   3. model   - fresh screenshot + yes/no question to /api/verify ("model-checked")
//   4. manual  - the user says it is done
//
// What we tested in headless Chromium against photopea.com on Fri 2 Oct 2026
// (tools/autolabel/probe.mjs re-runs all of this against this file's code):
//   - app.documents.length, document width/height, layer list (name, visible,
//     opacity, order) all come back through app.echoToOE.
//   - document.selection.bounds THROWS ("no selection") when nothing is selected
//     and returns 4 values when something is, so "is there a selection" works.
//   - document.historyStates.length works (names come back null).
//   - app.activeDocument.saveToOE("png") returns the composite with real alpha:
//     after clearing outside a selection, 63% of pixels were transparent, as expected.
//   - app.currentTool is NOT exposed, and isBackgroundLayer was false even for
//     "Background", so neither is used.
//   - One probing script never answered at all during testing, and the wrapper
//     waits for "done" forever. So every script below catches its own errors,
//     and every call goes through a queue with a timeout.
//
// Check spec (the "check" field of a step in steps.json):
//   { "type": "documentOpen" }
//   { "type": "selection", "expect": true }                 // false = nothing selected
//   { "type": "layerCount", "min": 2 } | { "max": 1 } | { "increasedBy": 1 }
//   { "type": "layerExists", "nameMatches": "colou?r" }
//   { "type": "historyGrew" }                              // the user changed something
//   { "type": "canvasSize", "width": 1080, "height": 1080 } | { "changed": true }
//   { "type": "transparency", "minFraction": 0.1, "maxFraction": 0.95 }
//   { "type": "pixel", "x": 0.02, "y": 0.02, "expect": "opaque" | "transparent" | "changed" }
//   { "type": "model", "doneWhen": "An export dialog showing PNG is open" }
//   { "type": "manual" }
//   { "type": "all", "checks": [ ...any of the above ] }
// Coordinates in "pixel" checks are fractions of the document size (0..1).

import { verifyStep } from "./modes.js";

const SCRIPT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// A serial queue around the photopea.js wrapper. The wrapper collects every
// message from the iframe until "done", so two overlapping calls would mix
// their outputs. Everything goes through one queue, each with a timeout.
// ---------------------------------------------------------------------------

export function createPeaQueue(pea, { timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  let chain = Promise.resolve();
  const withTimeout = (p, label) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Photopea ${label} timed out`)), timeoutMs)),
    ]);
  const enqueue = (fn, label) => {
    const run = chain.then(() => withTimeout(fn(), label));
    chain = run.catch(() => {}); // keep the queue alive after a failure
    return run;
  };
  return {
    runScript: (script) => enqueue(() => pea.runScript(script), "script"),
    exportImage: (type = "png") => enqueue(() => pea.exportImage(type), "export"),
  };
}

// ES5 on purpose: Photopea's scripting follows Photoshop's old JavaScript dialect.
export const FACTS_SCRIPT = `(function () {
  function px(v) { if (v === null || v === undefined) return null; return (v.value !== undefined) ? Number(v.value) : Number(v); }
  try {
    var out = { docs: app.documents.length };
    if (app.documents.length) {
      var d = app.activeDocument;
      out.width = px(d.width); out.height = px(d.height);
      out.layers = [];
      for (var i = 0; i < d.layers.length; i++) {
        var L = d.layers[i];
        out.layers.push({ name: String(L.name), visible: !!L.visible, opacity: px(L.opacity), typename: String(L.typename) });
      }
      try { out.activeLayer = d.activeLayer ? String(d.activeLayer.name) : null; } catch (e1) { out.activeLayer = null; }
      try { var b = d.selection.bounds; out.hasSelection = true; out.selection = [px(b[0]), px(b[1]), px(b[2]), px(b[3])]; }
      catch (e2) { out.hasSelection = false; out.selection = null; }
      try { out.historyCount = d.historyStates.length; } catch (e3) { out.historyCount = null; }
    }
    app.echoToOE(JSON.stringify(out));
  } catch (e) { app.echoToOE(JSON.stringify({ error: String(e && e.message || e) })); }
})();`;

/** Read document facts. Returns null if Photopea does not answer. */
export async function readDocFacts(q) {
  try {
    const outputs = await q.runScript(FACTS_SCRIPT);
    const text = outputs.find((o) => typeof o === "string" && o.startsWith("{"));
    if (!text) return null;
    const facts = JSON.parse(text);
    return facts.error ? null : facts;
  } catch {
    return null;
  }
}

/**
 * Export the composite as PNG and measure it. Downscaled to at most `maxSide`
 * pixels: enough for fractions and spot colours, fast enough to run after every step.
 */
export async function exportStats(q, { maxSide = 256 } = {}) {
  try {
    const blob = await q.exportImage("png");
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const data = ctx.getImageData(0, 0, w, h).data;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 16) transparent += 1;
    const sample = (fx, fy) => {
      const x = Math.min(w - 1, Math.max(0, Math.round(fx * (w - 1))));
      const y = Math.min(h - 1, Math.max(0, Math.round(fy * (h - 1))));
      const k = (y * w + x) * 4;
      return [data[k], data[k + 1], data[k + 2], data[k + 3]];
    };
    return { width: w, height: h, transparentFraction: transparent / (w * h), sample };
  } catch {
    return null;
  }
}

/** Take this at the start of each step; relative checks compare against it. */
export async function snapshot(q, { pixels = false } = {}) {
  const facts = await readDocFacts(q);
  const stats = pixels ? await exportStats(q) : null;
  return { facts, stats, at: Date.now() };
}

const DONE = "done";
const NOT_YET = "not_yet";
const UNKNOWN = "unknown";

const verdict = (status, method, detail) => ({ status, method, detail });

function colourDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
}

/**
 * Run one check.
 * @param check  the step's check spec
 * @param ctx    { q (peaQueue), before (snapshot), step, captureFrame?: () => canvas, sessionId, model?, accessCode? }
 * @returns {Promise<{status: "done"|"not_yet"|"unknown", method, detail}>}
 */
export async function runCheck(check, ctx) {
  if (!check || !check.type) return verdict(UNKNOWN, "manual", "no check defined for this step");
  const { q, before } = ctx;

  if (check.type === "all") {
    const results = [];
    for (const c of check.checks || []) {
      const r = await runCheck(c, ctx);
      results.push(r);
      if (r.status !== DONE) return verdict(r.status, r.method, `${c.type}: ${r.detail}`);
    }
    return verdict(DONE, results.map((r) => r.method).join("+"), "all checks passed");
  }

  if (check.type === "manual") return verdict(UNKNOWN, "manual", "ask the user");

  if (check.type === "model") {
    if (!ctx.captureFrame) return verdict(UNKNOWN, "model", "no frame source available");
    try {
      const frame = await ctx.captureFrame();
      const r = await verifyStep({
        frame, step: { ...ctx.step, check }, sessionId: ctx.sessionId, model: ctx.model, accessCode: ctx.accessCode,
      });
      const status = r.done === true ? DONE : r.done === false ? NOT_YET : UNKNOWN;
      return { ...verdict(status, "model", r.observation || r.say), say: r.say, confidence: r.confidence };
    } catch (e) {
      return verdict(UNKNOWN, "model", `verify failed: ${e.code || e.message}`);
    }
  }

  if (!q) return verdict(UNKNOWN, "script", "editor not connected");

  // --- Pixel checks ---
  if (check.type === "transparency" || check.type === "pixel") {
    const stats = await exportStats(q);
    if (!stats) return verdict(UNKNOWN, "pixels", "could not export the document");
    if (check.type === "transparency") {
      const f = stats.transparentFraction;
      const ok = f >= (check.minFraction ?? 0.05) && f <= (check.maxFraction ?? 0.98);
      return verdict(ok ? DONE : NOT_YET, "pixels", `transparent fraction ${f.toFixed(3)}`);
    }
    const px = stats.sample(check.x ?? 0.5, check.y ?? 0.5);
    if (check.expect === "opaque") return verdict(px[3] > 240 ? DONE : NOT_YET, "pixels", `alpha ${px[3]}`);
    if (check.expect === "transparent") return verdict(px[3] < 16 ? DONE : NOT_YET, "pixels", `alpha ${px[3]}`);
    if (check.expect === "changed") {
      if (!before?.stats) return verdict(UNKNOWN, "pixels", "no start snapshot with pixels (snapshot(q, { pixels: true }))");
      const was = before.stats.sample(check.x ?? 0.5, check.y ?? 0.5);
      const d = colourDistance(px, was);
      return verdict(d > (check.tolerance ?? 30) ? DONE : NOT_YET, "pixels", `colour moved by ${Math.round(d)}`);
    }
    return verdict(UNKNOWN, "pixels", `unknown pixel expectation ${check.expect}`);
  }

  // --- Script checks ---
  const facts = await readDocFacts(q);
  if (!facts) return verdict(UNKNOWN, "script", "Photopea did not answer");
  const layers = facts.layers || [];
  switch (check.type) {
    case "documentOpen":
      return verdict(facts.docs > 0 ? DONE : NOT_YET, "script", `${facts.docs} document(s) open`);
    case "selection": {
      const want = check.expect !== false;
      return verdict(facts.hasSelection === want ? DONE : NOT_YET, "script", facts.hasSelection ? "selection present" : "no selection");
    }
    case "layerCount": {
      const n = layers.length;
      if (check.increasedBy !== undefined) {
        const was = before?.facts?.layers?.length;
        if (was === undefined) return verdict(UNKNOWN, "script", "no start snapshot");
        return verdict(n - was >= check.increasedBy ? DONE : NOT_YET, "script", `${was} -> ${n} layers`);
      }
      const ok = n >= (check.min ?? 0) && n <= (check.max ?? Infinity);
      return verdict(ok ? DONE : NOT_YET, "script", `${n} layers`);
    }
    case "layerExists": {
      let re;
      try { re = new RegExp(check.nameMatches || ".", "i"); } catch { return verdict(UNKNOWN, "script", "bad nameMatches pattern"); }
      const found = layers.find((l) => re.test(l.name));
      return verdict(found ? DONE : NOT_YET, "script", found ? `found layer "${found.name}"` : "no matching layer");
    }
    case "historyGrew": {
      const was = before?.facts?.historyCount;
      if (typeof was !== "number" || typeof facts.historyCount !== "number") return verdict(UNKNOWN, "script", "history count unavailable");
      return verdict(facts.historyCount > was ? DONE : NOT_YET, "script", `history ${was} -> ${facts.historyCount}`);
    }
    case "canvasSize": {
      if (check.changed) {
        const b = before?.facts;
        if (!b) return verdict(UNKNOWN, "script", "no start snapshot");
        const changed = b.width !== facts.width || b.height !== facts.height;
        return verdict(changed ? DONE : NOT_YET, "script", `${b.width}x${b.height} -> ${facts.width}x${facts.height}`);
      }
      const ok = (check.width === undefined || facts.width === check.width) && (check.height === undefined || facts.height === check.height);
      return verdict(ok ? DONE : NOT_YET, "script", `canvas ${facts.width}x${facts.height}`);
    }
    default:
      return verdict(UNKNOWN, "script", `unknown check type ${check.type}`);
  }
}

// ---------------------------------------------------------------------------
// Evidence: how often did the automatic check agree with a human observer?
// The app (or the trial runner) records one entry per checked step.
// ---------------------------------------------------------------------------

const agreement = [];

export function recordAgreement({ stepId, status, method, humanSaysDone }) {
  agreement.push({ at: new Date().toISOString(), stepId, status, method, humanSaysDone: Boolean(humanSaysDone) });
}

export function getAgreementLog() {
  return agreement.slice();
}

/** Per method: n, agreed, unknown. "unknown" never counts as agreement. */
export function agreementSummary(log = agreement) {
  const by = {};
  for (const e of log) {
    const m = (by[e.method] ||= { n: 0, agreed: 0, unknown: 0 });
    m.n += 1;
    if (e.status === UNKNOWN) m.unknown += 1;
    else if ((e.status === DONE) === e.humanSaysDone) m.agreed += 1;
  }
  return by;
}
