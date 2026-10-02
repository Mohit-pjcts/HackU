// Brain Lab: run any pointing mode on saved screenshots, label true targets,
// and score all three modes on the same labelled set (build guide, Stage 5).

import { BrainError, getServerInfo, locate, newSessionId } from "../src/modes.js";
import { pointInBox } from "../src/shared/geometry.js";

const $ = (id) => document.getElementById(id);
const MODES = ["direct", "grid", "refine"];
const COLORS = { direct: "#22d3ee", grid: "#e879f9", refine: "#fb923c", label: "#4ade80" };

const state = {
  images: new Map(), // file name -> { bitmap, width, height }
  items: [], // { id, file, stepId, stepGoal, targetHint, transcript, box, split, source }
  current: null,
  results: new Map(), // item id -> { [mode]: row }
  labelling: false,
  drag: null,
  running: false,
  stopRequested: false,
  spent: 0,
  steps: [],
};

let nextId = 1;

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

async function showServer() {
  const info = await getServerInfo({ force: true });
  const srv = $("srv");
  if (!info.ok) {
    srv.textContent = `server unreachable (${info.error})`;
    srv.className = "chip bad";
  } else if (info.mock) {
    srv.textContent = "MOCK model: answers are fake";
    srv.className = "chip warn";
  } else if (!info.keyConfigured) {
    srv.textContent = `${info.model}: no API key on server`;
    srv.className = "chip bad";
  } else {
    srv.textContent = `model ${info.model} · effort ${info.effort || "default"} · floor ${info.confidenceFloor}`;
    srv.className = "chip ok";
  }
  const b = info.imageBudget;
  $("budget").textContent = b ? `image budget ${b.maxEdge}px / ${b.maxTokens} tokens` : "";
  const sel = $("model");
  sel.innerHTML = "";
  for (const m of info.allowedModels?.length ? info.allowedModels : ["(server default)"]) {
    const o = document.createElement("option");
    o.value = m === "(server default)" ? "" : m;
    o.textContent = m;
    sel.appendChild(o);
  }
  try { $("code").value = sessionStorage.getItem("brainlab.code") || ""; } catch { /* storage blocked */ }
}

async function loadSteps() {
  try {
    const r = await fetch("../src/steps.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    state.steps = Array.isArray(j) ? j : j.steps || [];
  } catch { return; }
  if (!state.steps.length) return;
  const pick = $("stepPick");
  pick.innerHTML = '<option value="">(choose a step)</option>';
  state.steps.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${s.id}: ${s.goal}`.slice(0, 80);
    pick.appendChild(o);
  });
  $("stepPickWrap").hidden = false;
  pick.addEventListener("change", () => {
    const s = state.steps[Number(pick.value)];
    if (!s) return;
    $("stepId").value = s.id || "";
    $("goal").value = s.goal || "";
    $("hint").value = s.targetHint || "";
    saveStepFields();
  });
}

// ---------------------------------------------------------------------------
// Images and items
// ---------------------------------------------------------------------------

async function addImageFile(file) {
  const bitmap = await createImageBitmap(file);
  state.images.set(file.name, { bitmap, width: bitmap.width, height: bitmap.height });
  return file.name;
}

function makeItem(file, extra = {}) {
  const item = {
    id: nextId++,
    file,
    stepId: $("stepId").value.trim(),
    stepGoal: $("goal").value.trim(),
    targetHint: $("hint").value.trim(),
    transcript: $("said").value.trim(),
    box: null,
    split: "tune",
    source: "hand",
    ...extra,
  };
  state.items.push(item);
  return item;
}

async function handleFiles(files) {
  const list = Array.from(files);
  const jsons = list.filter((f) => f.name.endsWith(".json"));
  const imgs = list.filter((f) => /^image\/(png|jpeg)$/.test(f.type));
  for (const f of imgs) await addImageFile(f);
  let labelled = 0;
  for (const j of jsons) {
    try {
      const data = JSON.parse(await j.text());
      for (const it of data.items || []) {
        makeItem(it.file, {
          stepId: it.stepId || "", stepGoal: it.stepGoal || "", targetHint: it.targetHint || "", transcript: it.transcript || "",
          box: Array.isArray(it.box) ? it.box : null, split: it.split === "report" ? "report" : "tune", source: it.source || "file",
          meta: it.meta,
        });
        labelled += 1;
      }
    } catch (e) {
      setStatus(`Could not read ${j.name}: ${e.message}`);
    }
  }
  // Images that no label item refers to get one empty item each.
  for (const f of imgs) {
    if (!state.items.some((it) => it.file === f.name)) makeItem(f.name);
  }
  const missing = new Set(state.items.filter((it) => !state.images.has(it.file)).map((it) => it.file));
  setStatus(`${imgs.length} image(s), ${labelled} label item(s) loaded.` + (missing.size ? ` ${missing.size} labelled file(s) not loaded yet: pick those images too.` : ""));
  if (!state.current && state.items.length) select(state.items.find((it) => state.images.has(it.file))?.id ?? state.items[0].id);
  renderItems();
}

async function addSynthetic(kind) {
  const c = document.createElement("canvas");
  c.width = 1920;
  c.height = 1080;
  const ctx = c.getContext("2d");
  if (kind === "blank") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  } else {
    // An unrelated screen: a text-heavy page with no editor in it.
    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#222";
    ctx.font = "bold 44px Georgia, serif";
    ctx.fillText("Campus Weekly — Week 6 Bulletin", 120, 140);
    ctx.font = "24px Georgia, serif";
    for (let i = 0; i < 22; i += 1) {
      ctx.fillText("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.", 120, 220 + i * 36);
    }
  }
  const name = `${kind}-${nextId}.png`;
  const bitmap = await createImageBitmap(c);
  state.images.set(name, { bitmap, width: c.width, height: c.height });
  const item = makeItem(name, { source: "synthetic", meta: { expect: "cannot_tell" } });
  select(item.id);
}

function renderItems() {
  const box = $("items");
  box.innerHTML = "";
  for (const it of state.items) {
    const d = document.createElement("div");
    if (it.id === state.current) d.className = "cur";
    const res = state.results.get(it.id);
    const marks = res ? MODES.filter((m) => res[m]).map((m) => (res[m].hit === true ? "✓" : res[m].cannotTell ? "?" : res[m].hit === false ? "✗" : "·")).join("") : "";
    const loaded = state.images.has(it.file) ? "" : " (image not loaded)";
    d.innerHTML = `<span></span><span class="tag"></span>`;
    d.firstChild.textContent = `${it.file} · ${it.stepId || "no step"}${loaded}`;
    d.lastChild.textContent = `${it.box ? it.split : "unlabelled"} ${marks}`;
    d.addEventListener("click", () => select(it.id));
    box.appendChild(d);
  }
}

function currentItem() {
  return state.items.find((it) => it.id === state.current) || null;
}

function select(id) {
  state.current = id;
  const it = currentItem();
  if (it) {
    $("stepId").value = it.stepId;
    $("goal").value = it.stepGoal;
    $("hint").value = it.targetHint;
    $("said").value = it.transcript;
    $("split").value = it.split;
  }
  renderItems();
  draw();
  renderOne();
}

function saveStepFields() {
  const it = currentItem();
  if (!it) return;
  it.stepId = $("stepId").value.trim();
  it.stepGoal = $("goal").value.trim();
  it.targetHint = $("hint").value.trim();
  it.transcript = $("said").value.trim();
  it.split = $("split").value;
  renderItems();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function viewScale(img) {
  const canvas = $("view");
  const maxW = Math.max(320, canvas.parentElement.parentElement.clientWidth - 8);
  return Math.min(1, maxW / img.width);
}

function draw() {
  const canvas = $("view");
  const ctx = canvas.getContext("2d");
  const it = currentItem();
  const img = it && state.images.get(it.file);
  if (!img) {
    canvas.width = 960;
    canvas.height = 200;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#9aa4b2";
    ctx.font = "16px system-ui";
    ctx.fillText(it ? `Load ${it.file} to see this item.` : "Load screenshots to begin.", 20, 40);
    return;
  }
  const s = viewScale(img);
  canvas.width = Math.round(img.width * s);
  canvas.height = Math.round(img.height * s);
  ctx.drawImage(img.bitmap, 0, 0, canvas.width, canvas.height);

  const box = state.drag?.box || it.box;
  if (box) {
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.label;
    ctx.strokeRect(box[0] * s, box[1] * s, (box[2] - box[0]) * s, (box[3] - box[1]) * s);
    ctx.setLineDash([]);
  }
  const res = state.results.get(it.id) || {};
  for (const m of MODES) {
    const r = res[m];
    if (!r) continue;
    ctx.strokeStyle = COLORS[m];
    ctx.fillStyle = COLORS[m];
    ctx.lineWidth = 2;
    if (r.frameBox) ctx.strokeRect(r.frameBox[0] * s, r.frameBox[1] * s, (r.frameBox[2] - r.frameBox[0]) * s, (r.frameBox[3] - r.frameBox[1]) * s);
    const p = r.framePoint || r.modelGuess;
    if (p) {
      ctx.beginPath();
      ctx.arc(p.x * s, p.y * s, 7, 0, Math.PI * 2);
      if (r.framePoint) ctx.fill();
      else ctx.stroke();
      ctx.font = "bold 12px system-ui";
      ctx.fillText(m, p.x * s + 10, p.y * s - 8);
    }
  }
}

function canvasToImage(ev) {
  const it = currentItem();
  const img = it && state.images.get(it.file);
  if (!img) return null;
  const rect = $("view").getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * img.width;
  const y = ((ev.clientY - rect.top) / rect.height) * img.height;
  return { x: Math.round(Math.max(0, Math.min(img.width, x))), y: Math.round(Math.max(0, Math.min(img.height, y))) };
}

function setupLabelling() {
  const canvas = $("view");
  canvas.addEventListener("pointerdown", (ev) => {
    if (!state.labelling) return;
    const p = canvasToImage(ev);
    if (!p) return;
    canvas.setPointerCapture(ev.pointerId);
    state.drag = { start: p, box: [p.x, p.y, p.x, p.y] };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!state.drag) return;
    const p = canvasToImage(ev);
    if (!p) return;
    const a = state.drag.start;
    state.drag.box = [Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y)];
    draw();
  });
  canvas.addEventListener("pointerup", () => {
    if (!state.drag) return;
    const it = currentItem();
    const b = state.drag.box;
    state.drag = null;
    if (it && b[2] - b[0] >= 3 && b[3] - b[1] >= 3) {
      it.box = b;
      it.source = it.source === "file" ? "file+edited" : "hand";
      // Re-score existing results against the new label.
      const res = state.results.get(it.id);
      if (res) for (const m of MODES) if (res[m]) res[m].hit = scoreHit(res[m], it);
    }
    renderItems();
    draw();
    renderOne();
  });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function selectedModes() {
  return Array.from(document.querySelectorAll(".mode:checked")).map((el) => el.value);
}

function scoreHit(r, item) {
  if (!item.box || !r.framePoint) return item.box ? false : null;
  return pointInBox(r.framePoint, item.box, Number($("tol").value) || 0);
}

function rawHit(r, item) {
  const p = r.framePoint || r.modelGuess;
  if (!item.box || !p) return item.box ? false : null;
  return pointInBox(p, item.box, Number($("tol").value) || 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runModeOnItem(item, mode, { sentSink } = {}) {
  const img = state.images.get(item.file);
  if (!img) throw new Error(`image ${item.file} is not loaded`);
  const accessCode = $("code").value.trim();
  // A fresh session per item keeps the per-session cap from stopping a long batch.
  const sessionId = newSessionId();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const r = await locate({
        frame: img.bitmap,
        step: { id: item.stepId || "lab", goal: item.stepGoal || "Find the next thing to click", targetHint: $("sendHint").checked ? item.targetHint : "" },
        transcript: item.transcript,
        mode,
        firstPass: $("firstPass").value,
        grid: { cols: Number($("cols").value) || 12, rows: Number($("rows").value) || 8 },
        sessionId,
        model: $("model").value || undefined,
        accessCode,
        onSend: sentSink ? (s) => sentSink.push(s) : undefined,
      });
      const row = { ...r, model: r.passes?.[0]?.model, at: new Date().toISOString() };
      row.hit = scoreHit(row, item);
      row.rawHit = rawHit(row, item);
      if (typeof r.costUsd === "number") state.spent += r.costUsd;
      return row;
    } catch (e) {
      if (e instanceof BrainError && (e.code === "RATE_LIMITED" || e.code === "MODEL_RATE_LIMITED" || e.code === "MODEL_BUSY")) {
        const wait = Math.max(2, e.retryAfterSec || 5);
        setStatus(`${e.code}: waiting ${wait}s before retrying…`);
        await sleep(wait * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("gave up after repeated rate limits");
}

function renderSent(sent) {
  const box = $("sent");
  box.innerHTML = "";
  for (const s of sent) {
    const fig = document.createElement("figure");
    const im = document.createElement("img");
    im.src = s.canvas.toDataURL("image/jpeg", 0.7);
    const cap = document.createElement("figcaption");
    cap.textContent = `${s.mode} · ${s.canvas.width}x${s.canvas.height} · ${(s.bytes / 1024).toFixed(0)} KB`;
    fig.append(im, cap);
    box.appendChild(fig);
  }
}

async function runOne() {
  const it = currentItem();
  if (!it) return setStatus("Load an image first.");
  saveStepFields();
  const modes = selectedModes();
  if (!modes.length) return setStatus("Pick at least one mode.");
  setBusy(true);
  const sent = [];
  renderSent(sent);
  const res = state.results.get(it.id) || {};
  state.results.set(it.id, res);
  try {
    for (const m of modes) {
      if (state.stopRequested) break;
      setStatus(`Running ${m}…`);
      try {
        res[m] = await runModeOnItem(it, m, { sentSink: sent });
      } catch (e) {
        res[m] = { error: e.code || "ERROR", say: e.say || e.message, hit: it.box ? false : null };
      }
      renderSent(sent);
      draw();
      renderOne();
    }
    setStatus("Done.");
  } finally {
    setBusy(false);
    renderItems();
    renderSummary();
  }
}

async function runBatch() {
  const split = $("batchSplit").value;
  // Labelled targets in the chosen split, plus every "should refuse" screen (blank / unrelated).
  const isNegative = (it) => it.meta?.expect === "cannot_tell";
  const items = state.items.filter((it) => state.images.has(it.file) &&
    ((it.box && (split === "all" || it.split === split)) || isNegative(it)));
  const modes = selectedModes();
  if (!items.length) return setStatus("No labelled items (or blank / unrelated screens) with loaded images in that split.");
  if (!modes.length) return setStatus("Pick at least one mode.");
  setBusy(true);
  const jobs = [];
  for (const it of items) for (const m of modes) jobs.push({ it, m });
  let done = 0;
  let failed = 0;
  const conc = Number($("conc").value) || 1;
  const worker = async () => {
    while (jobs.length && !state.stopRequested) {
      const { it, m } = jobs.shift();
      const res = state.results.get(it.id) || {};
      state.results.set(it.id, res);
      try {
        res[m] = await runModeOnItem(it, m);
      } catch (e) {
        failed += 1;
        res[m] = { error: e.code || "ERROR", say: e.say || e.message, hit: false };
      }
      done += 1;
      setStatus(`Batch: ${done} done, ${jobs.length} left${failed ? `, ${failed} errors` : ""}. Spent $${state.spent.toFixed(4)}.`);
      if (it.id === state.current) { draw(); renderOne(); }
      if (done % 5 === 0) { renderItems(); renderSummary(); }
    }
  };
  try {
    await Promise.all(Array.from({ length: conc }, worker));
    setStatus(`Batch finished: ${done} answers${failed ? `, ${failed} errors (counted as misses)` : ""}${state.stopRequested ? " (stopped early)" : ""}.`);
  } finally {
    setBusy(false);
    renderItems();
    renderSummary();
  }
}

function setBusy(b) {
  state.running = b;
  state.stopRequested = false;
  $("runOne").disabled = b;
  $("runBatch").disabled = b;
  $("stop").disabled = !b;
  $("spend").textContent = `spent this page: $${state.spent.toFixed(4)}`;
}

function setStatus(t) {
  $("status").textContent = t;
  $("spend").textContent = `spent this page: $${state.spent.toFixed(4)}`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const fmtMs = (ms) => (ms == null ? "" : `${(ms / 1000).toFixed(2)} s`);
const fmtUsd = (v) => (v == null ? "n/a" : `$${v.toFixed(4)}`);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");

function renderOne() {
  const tbody = $("oneTable").querySelector("tbody");
  tbody.innerHTML = "";
  const it = currentItem();
  const res = (it && state.results.get(it.id)) || {};
  for (const m of MODES) {
    const r = res[m];
    if (!r) continue;
    const tr = document.createElement("tr");
    let result;
    let cls;
    if (r.error) { result = `error ${r.error}`; cls = "miss"; }
    else if (r.cannotTell) { result = `can't tell (${r.reason || "?"})`; cls = "ct"; }
    else if (r.hit === true) { result = "hit"; cls = "hit"; }
    else if (r.hit === false) { result = "miss"; cls = "miss"; }
    else { result = "pointed (no label)"; cls = ""; }
    if (r.refined) result += ` · refined, moved ${r.agreementPx}px`;
    const cells = [
      m, result, r.confidence != null ? r.confidence.toFixed(2) : "", r.say || "", r.calls ?? "",
      fmtMs(r.latencyMs), r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens}` : "", fmtUsd(r.costUsd),
    ];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = String(c);
      if (i === 1) td.className = cls;
      if ([2, 4, 5, 6, 7].includes(i)) td.classList.add("num");
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function rowsFor(mode, split) {
  const out = [];
  for (const it of state.items) {
    if (!it.box) continue;
    if (split !== "all" && it.split !== split) continue;
    const r = state.results.get(it.id)?.[mode];
    if (r) out.push({ it, r });
  }
  return out;
}

function renderSummary() {
  const split = $("batchSplit").value;
  const tbody = $("sumTable").querySelector("tbody");
  tbody.innerHTML = "";
  const sweepHead = $("sweepTable").querySelector("thead");
  const sweepBody = $("sweepTable").querySelector("tbody");
  const floors = [0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9];
  sweepHead.innerHTML = `<tr><th>Mode</th>${floors.map((f) => `<th class="num">floor ${f}</th>`).join("")}</tr>`;
  sweepBody.innerHTML = "";
  for (const m of MODES) {
    const rows = rowsFor(m, split);
    if (!rows.length) continue;
    const n = rows.length;
    const ok = rows.filter(({ r }) => !r.error);
    const pointed = ok.filter(({ r }) => !r.cannotTell);
    const hits = pointed.filter(({ r }) => r.hit === true).length;
    const ct = ok.filter(({ r }) => r.cannotTell).length;
    const raw = ok.filter(({ r }) => r.rawHit === true).length;
    const lat = median(ok.map(({ r }) => r.latencyMs).filter((v) => v != null));
    const calls = ok.reduce((s, { r }) => s + (r.calls || 0), 0);
    const costs = ok.map(({ r }) => r.costUsd).filter((v) => typeof v === "number");
    const cells = [
      m, n, pct(hits, n), pct(pointed.length - hits, n), pct(ct, n), n - ok.length, pct(hits, pointed.length), pct(raw, n),
      fmtMs(lat), ok.length ? (calls / ok.length).toFixed(2) : "–", costs.length ? fmtUsd(costs.reduce((a, b) => a + b, 0) / costs.length) : "n/a",
    ];
    const tr = document.createElement("tr");
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = String(c);
      if (i > 0) td.className = "num";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);

    // Sweep: use the final point if shown, else the withheld guess.
    const str = document.createElement("tr");
    str.innerHTML = `<td>${m}</td>`;
    for (const f of floors) {
      const kept = ok.filter(({ r }) => (r.framePoint || r.modelGuess) && r.confidence >= f && r.reason !== "model_says_not_visible");
      const kh = kept.filter(({ r }) => r.rawHit === true).length;
      const td = document.createElement("td");
      td.className = "num";
      td.textContent = `${pct(kept.length, n)} / ${pct(kh, kept.length)}`;
      td.title = "coverage / precision";
      str.appendChild(td);
    }
    sweepBody.appendChild(str);
  }

  // Screens with nothing to point at: the right answer is "I can't tell".
  const negBody = $("negTable").querySelector("tbody");
  negBody.innerHTML = "";
  for (const m of MODES) {
    const rows = state.items.filter((it) => it.meta?.expect === "cannot_tell").map((it) => state.results.get(it.id)?.[m]).filter((r) => r && !r.error);
    if (!rows.length) continue;
    const refused = rows.filter((r) => r.cannotTell).length;
    const tr = document.createElement("tr");
    [m, rows.length, pct(refused, rows.length), pct(rows.length - refused, rows.length)].forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = String(c);
      if (i > 0) td.className = "num";
      tr.appendChild(td);
    });
    negBody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function resultRows() {
  const rows = [];
  for (const it of state.items) {
    const res = state.results.get(it.id) || {};
    for (const m of MODES) {
      const r = res[m];
      if (!r) continue;
      rows.push({
        file: it.file, stepId: it.stepId, split: it.split, labelSource: it.source, expect: it.meta?.expect || (it.box ? "point" : ""), mode: m,
        model: r.model || "", hit: r.hit, rawHit: r.rawHit ?? null, cannotTell: r.cannotTell ?? null, reason: r.reason ?? r.error ?? null,
        confidence: r.confidence ?? null, pointX: r.framePoint?.x ?? null, pointY: r.framePoint?.y ?? null,
        guessX: r.modelGuess?.x ?? null, guessY: r.modelGuess?.y ?? null, box: it.box ? it.box.join(" ") : "",
        refined: r.refined ?? null, refineMissed: r.refineMissed ?? null, refineError: r.refineError ?? null, agreementPx: r.agreementPx ?? null, calls: r.calls ?? null, latencyMs: r.latencyMs ?? null,
        inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null, costUsd: r.costUsd ?? null,
        say: r.say || "", at: r.at || "",
      });
    }
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  $("files").addEventListener("change", (e) => handleFiles(e.target.files));
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); });
  document.addEventListener("paste", async (e) => {
    const f = Array.from(e.clipboardData?.files || []).find((x) => x.type.startsWith("image/"));
    if (!f) return;
    const named = new File([f], `pasted-${Date.now()}.png`, { type: f.type });
    await addImageFile(named);
    const item = makeItem(named.name);
    select(item.id);
  });
  $("addBlank").addEventListener("click", () => addSynthetic("blank"));
  $("addNoise").addEventListener("click", () => addSynthetic("unrelated"));
  $("labelBtn").addEventListener("click", () => {
    state.labelling = !state.labelling;
    $("labelBtn").classList.toggle("on", state.labelling);
    $("labelBtn").textContent = state.labelling ? "Labelling: drag on image" : "Draw label box";
  });
  for (const id of ["stepId", "goal", "hint", "said", "split"]) $(id).addEventListener("change", saveStepFields);
  $("runOne").addEventListener("click", runOne);
  $("runBatch").addEventListener("click", runBatch);
  $("stop").addEventListener("click", () => { state.stopRequested = true; setStatus("Stopping after the current call…"); });
  $("batchSplit").addEventListener("change", renderSummary);
  $("tol").addEventListener("change", () => {
    for (const it of state.items) {
      const res = state.results.get(it.id);
      if (res) for (const m of MODES) if (res[m] && !res[m].error) { res[m].hit = scoreHit(res[m], it); res[m].rawHit = rawHit(res[m], it); }
    }
    renderOne(); renderSummary(); renderItems();
  });
  $("code").addEventListener("change", () => { try { sessionStorage.setItem("brainlab.code", $("code").value); } catch { /* ignore */ } });
  $("exportLabels").addEventListener("click", () => {
    const items = state.items.filter((it) => it.box).map(({ file, stepId, stepGoal, targetHint, transcript, box, split, source, meta }) =>
      ({ file, stepId, stepGoal, targetHint, transcript, box, split, source, ...(meta ? { meta } : {}) }));
    download("labels.json", JSON.stringify({ version: 1, items }, null, 2), "application/json");
  });
  $("exportJson").addEventListener("click", () => download("results.json", JSON.stringify({ exportedAt: new Date().toISOString(), rows: resultRows() }, null, 2), "application/json"));
  $("exportCsv").addEventListener("click", () => download("results.csv", toCsv(resultRows()), "text/csv"));
  window.addEventListener("resize", draw);
  setupLabelling();
}

wire();
showServer();
loadSteps();
draw();

// For automated runs (tools/autolabel): expose a tiny API.
window.brainLab = { state, handleFiles, runBatch, runOne, resultRows, select, addSynthetic };
