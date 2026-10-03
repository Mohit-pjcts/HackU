// One claim, from a fresh form to either "verified with proof" or "exception with a reason".
//
//   observe (one snapshot per step) -> perceive -> read back every field -> decide (jev) -> confidence gate
//   -> act (a recipe per control type) -> ... -> submit guard -> submit -> ORACLE (the form's own database)
//
// Only the oracle decides "done". jev saying "done" just triggers the same check.
import type {
  ActionResult,
  Claim,
  Classifier,
  Decision,
  Driver,
  ExceptionCode,
  Facts,
  AgentName,
  BatchItem,
  Item,
  Logger,
  WindowRef,
} from "./contracts.ts";
import { emptyCounts } from "./contracts.ts";
import { GATE, PRICE_PER_TOKEN } from "./decide.ts";
import { perceive, signature } from "./perceive.ts";
import { nowIso } from "./logger.ts";
import { pickWindow } from "./windows.ts";
import {
  CLEAR_LABEL,
  SUBMIT_LABEL,
  Oracle,
  clickLabel,
  fieldForItem,
  fillControl,
  goalFor,
  itemByLabel,
  pageIsClaimsForm,
  readBack,
  type ActOutcome,
} from "./adapters/claims-form.ts";

export const MAX_STEPS = 16;

export interface AgentStatus {
  agent: AgentName;
  status: "idle" | "preparing" | "observing" | "deciding" | "acting" | "verifying" | "paused" | "error";
  itemId?: string;
  step: number;
  note?: string;
}

export interface RunCtx {
  runId: string;
  driver: Driver;
  agent: AgentName;
  classifier: Classifier;
  oracle: Oracle;
  log: Logger;
  signal: AbortSignal;
  maxSteps?: number;
  onStatus?: (s: AgentStatus) => void;
  sleep?: (ms: number) => Promise<void>;
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tally(counts: BatchItem["counts"], results: ActionResult[], asCode = false) {
  for (const r of results) {
    if (asCode) counts.code++;
    else if (r.channel === "script") counts.script++;
    else if (r.channel === "foreground") counts.foreground++;
    else counts.gui++;
  }
}

const topOf = (p?: Record<string, number>) =>
  p ? Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ") : "";

export async function runItem(ctx: RunCtx, item: BatchItem): Promise<BatchItem> {
  const { driver, agent, classifier, oracle, log, signal } = ctx;
  const sleep = ctx.sleep ?? sleepDefault;
  const max = ctx.maxSteps ?? MAX_STEPS;
  const claim = item.claim as Claim;
  const t0 = performance.now();
  item.status = "running";
  item.steps = 0;
  item.costUsd = 0;
  item.counts = emptyCounts();
  const status = (s: AgentStatus["status"], step = item.steps, note?: string) => ctx.onStatus?.({ agent, status: s, itemId: item.id, step, note });

  const finish = (code: ExceptionCode | null, reason = "", proof?: BatchItem["proof"]): BatchItem => {
    item.seconds = (performance.now() - t0) / 1000;
    if (code) {
      item.status = "exception";
      item.exception = { code, reason };
    } else {
      item.status = "verified";
      item.proof = proof;
    }
    status("idle");
    log.write({ type: "item_end", runId: ctx.runId, t: nowIso(), item });
    return item;
  };

  let win: WindowRef;
  try {
    status("preparing", 0);
    await driver.ensureSession(agent);
    win = await pickWindow(driver, "Safari");
  } catch (e: any) {
    return finish("page_lost", String(e?.message ?? e));
  }
  const actCtx = { driver, agent, win };
  const countAtStart = await oracle.count();

  const tried: string[] = [];
  const prev: string[] = [];
  let lastSig = "";
  let idle = 0;
  let repeats = 0;
  let clears = 0;
  let preparedOnce = false;

  for (let step = 1; step <= max; step++) {
    if (signal.aborted) return finish("stopped", "stopped by the operator");
    item.steps = step;

    // ---- observe ----
    status("observing", step);
    let obs = await driver.observe(agent, win);
    if (obs.degraded === "session_ended") {
      await driver.ensureSession(agent);
      obs = await driver.observe(agent, win);
    }
    if (obs.degraded && obs.elements.length === 0) {
      return finish("page_lost", `Safari window could not be read (${obs.degraded}). Is it on another Space, minimised or full-screen?`);
    }
    const items = perceive(obs);
    if (!pageIsClaimsForm(obs) || items.length === 0) {
      return finish("page_lost", "the Safari window is not showing the claims form");
    }
    const filled = readBack(items, claim);
    const anyWrong = Object.values(filled).some((s) => s === "wrong");
    const allOk = Object.values(filled).every((s) => s === "ok");
    log.write({ type: "readback", runId: ctx.runId, t: nowIso(), itemId: item.id, filled, pass: allOk });

    const sig = signature(items);
    if (sig === lastSig) idle++;
    else {
      idle = 0;
      tried.length = 0;
    }
    lastSig = sig;
    if (idle >= 3) return finish("stalled", "3 actions in a row left the page unchanged");

    // ---- code-level preparation: start from an empty form, and clear wrong values once ----
    const dirty = items.some((i) => (i.role === "AXTextField" || i.role === "AXPopUpButton") && fieldForItem(i) && i.state === "filled") || items.some((i) => i.role === "AXRadioButton" && i.state === "selected");
    const needClear = (!preparedOnce && dirty) || anyWrong;
    if (needClear) {
      if (anyWrong && clears >= 2) {
        const bad = Object.entries(filled).filter(([, s]) => s === "wrong").map(([k]) => k).join(", ");
        return finish("field_mismatch", `after clearing the form twice, the page still shows a wrong value for: ${bad}`);
      }
      clears++;
      preparedOnce = true;
      status("acting", step, "clearing the form");
      const out = await clickLabel(actCtx, items, CLEAR_LABEL);
      tally(item.counts, out.results, true);
      const codeDecision: Decision = { kind: "clear_form", kindP: { clear_form: 1 }, kindConf: 1, gate: 1, backend: "code", model: "readback-rule", inputTokens: 0, ms: 0 };
      log.write({
        type: "step", runId: ctx.runId, t: nowIso(), agent, itemId: item.id, step, items,
        facts: { goal: goalFor(claim), claim: claim as unknown as Record<string, string>, filled, previousActions: prev.slice(-8), alreadyTriedHere: tried },
        decision: codeDecision, acted: out.blocked ? `blocked: ${out.blocked}` : `${out.desc} (code: ${anyWrong ? "wrong value found by read-back" : "start from an empty form"})`,
        results: out.results, ms: { observe: obs.ms, decide: 0, act: out.results.reduce((a, r) => a + r.ms, 0) },
      });
      prev.push(out.desc);
      if (out.results.some((r) => !r.ok)) return driverRefused(finish, out.results);
      tried.length = 0;
      continue;
    }
    preparedOnce = true;

    // ---- decide ----
    status("deciding", step);
    const facts: Facts = {
      goal: goalFor(claim),
      claim: claim as unknown as Record<string, string>,
      filled,
      previousActions: prev.slice(-8),
      alreadyTriedHere: [...tried],
    };
    const dec = await classifier.classify(facts, items);
    item.counts.decisions++;
    item.costUsd += dec.inputTokens * PRICE_PER_TOKEN;

    const logStep = (acted: string, results: ActionResult[], actMs: number) =>
      log.write({
        type: "step", runId: ctx.runId, t: nowIso(), agent, itemId: item.id, step, items, facts, decision: dec,
        acted, results, ms: { observe: obs.ms, decide: dec.ms, act: Math.round(actMs) },
      });

    // ---- gate: escalate rather than guess ----
    if (dec.kind === "none") {
      logStep("none: the classifier found nothing on the page that helps", [], 0);
      return finish("stalled", "the classifier found nothing on the page that helps with this claim");
    }
    if (dec.kind !== "done" && dec.kind !== "wait" && dec.gate < GATE) {
      logStep(`gated: confidence ${dec.gate.toFixed(2)} < ${GATE}`, [], 0);
      return finish("low_confidence", `confidence ${dec.gate.toFixed(2)} is below ${GATE} (kind: ${topOf(dec.kindP)}${dec.itemP ? `; item: ${topOf(dec.itemP)}` : ""})`);
    }

    // ---- act ----
    status("acting", step, dec.kind);
    const chosen: Item | undefined = dec.item === undefined ? undefined : items.find((i) => i.i === dec.item);
    const key = `${dec.kind}:${chosen?.id ?? ""}:${dec.field ?? ""}`;
    if (tried.includes(key)) {
      repeats++;
      if (repeats >= 2) {
        logStep(`repeat of an action already tried: ${key}`, [], 0);
        return finish("stalled", `the same action was chosen again on an unchanged page (${key})`);
      }
    }
    tried.push(key);

    let kind = dec.kind;
    // a click on the Submit / Clear buttons is routed to the matching guarded step
    if (kind === "click_item" && chosen?.text === SUBMIT_LABEL) kind = "submit";
    if (kind === "click_item" && chosen?.text === CLEAR_LABEL) kind = "clear_form";

    if (kind === "wait") {
      logStep("wait", [], 500);
      await sleep(500);
      continue;
    }

    if (kind === "done") {
      status("verifying", step);
      const res = await oracle.verify(claim, countAtStart);
      log.write({ type: "oracle", runId: ctx.runId, t: nowIso(), itemId: item.id, phase: "after_done", result: res });
      logStep("done: asked the form's database", [], res.ms);
      if (res.ok) return finish(null, "", res);
      item.counts.falseDoneCaught++;
      return finish("false_done", `the classifier said done, but the form's database disagrees: ${res.diff.join("; ")}`);
    }

    let out: ActOutcome;
    if (kind === "fill_field" || kind === "click_item") {
      if (!chosen) {
        out = { desc: "no such control", results: [], blocked: `the classifier chose item ${dec.item}, which is not on the page` };
      } else {
        const spec = fieldForItem(chosen);
        if (dec.field && spec && dec.field !== spec.key) {
          out = { desc: `fill ${chosen.text}`, results: [], blocked: `classifier picked the "${chosen.text}" control for "${dec.field}", but it belongs to "${spec.key}"` };
        } else if (kind === "click_item" && chosen.role !== "AXRadioButton") {
          out = { desc: `click ${chosen.text}`, results: [], blocked: `only radio buttons are clicked on this form (not "${chosen.text}")` };
        } else {
          out = await fillControl(actCtx, chosen, claim);
        }
      }
    } else if (kind === "clear_form") {
      if (clears >= 2) return finish("field_mismatch", "the form was cleared twice and is still not correct");
      clears++;
      out = await clickLabel(actCtx, items, CLEAR_LABEL);
    } else if (kind === "submit") {
      if (!allOk) {
        item.counts.submitBlocked++;
        const missing = Object.entries(filled).filter(([, s]) => s !== "ok").map(([k, s]) => `${k} (${s})`).join(", ");
        log.write({ type: "guard", runId: ctx.runId, t: nowIso(), itemId: item.id, rule: "submit_blocked", detail: `read-back not clean: ${missing}` });
        logStep(`submit blocked: ${missing}`, [], 0);
        repeats++;
        if (repeats >= 3) return finish("stalled", `Submit was blocked three times: ${missing}`);
        continue;
      }
      const btn = itemByLabel(items, SUBMIT_LABEL, "AXButton");
      if (!btn?.token) return finish("page_lost", `no "${SUBMIT_LABEL}" button on the page`);
      const before = await oracle.count();
      const t1 = performance.now();
      const r = await driver.click(agent, win, btn.token);
      tally(item.counts, [r]);
      if (!r.ok) {
        logStep("submit refused", [r], r.ms);
        return driverRefused(finish, [r]);
      }
      await sleep(900); // the page posts and reloads
      status("verifying", step);
      const res = await oracle.verify(claim, before);
      log.write({ type: "oracle", runId: ctx.runId, t: nowIso(), itemId: item.id, phase: "final", result: res });
      logStep(`click "${SUBMIT_LABEL}" then ask the form's database`, [r], performance.now() - t1);
      if (res.ok) return finish(null, "", res);
      return finish("oracle_mismatch", `the form's database does not match: ${res.diff.join("; ")}`);
    } else {
      out = { desc: `unsupported ${kind}`, results: [], blocked: `unsupported action kind ${kind}` };
    }

    tally(item.counts, out.results);
    logStep(out.blocked ? `blocked: ${out.blocked}` : out.desc, out.results, out.results.reduce((a, r) => a + r.ms, 0));
    prev.push(out.blocked ? `(blocked) ${out.desc}` : out.desc);
    if (out.blocked) {
      log.write({ type: "guard", runId: ctx.runId, t: nowIso(), itemId: item.id, rule: "action_blocked", detail: out.blocked });
      repeats++;
      if (repeats >= 2) return finish("stalled", `the classifier kept choosing an action the guard refuses: ${out.blocked}`);
      continue;
    }
    const bad = out.results.find((r) => !r.ok);
    if (bad) {
      if (bad.error?.code === "session_ended") {
        await driver.ensureSession(agent);
        continue;
      }
      return driverRefused(finish, out.results);
    }
  }
  return finish("step_limit", `more than ${max} steps without finishing`);
}

function driverRefused(finish: (c: ExceptionCode, r: string) => BatchItem, results: ActionResult[]): BatchItem {
  const bad = results.find((r) => !r.ok);
  return finish("driver_refused", `${bad?.error?.code ?? "refused"}: ${bad?.error?.detail ?? ""}`);
}
