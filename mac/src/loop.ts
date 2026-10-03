// One agent doing one task in one window:
//   observe (accessibility tree, text only) -> perceive (<=40 controls + text on screen) -> brain decides
//   -> confidence gate (escalate rather than guess) -> act (click / type / key / scroll) -> ... -> "done"?
//   -> verifier reads the screen -> achieved (with the answer) or keep going / give up with a reason.
import type { AxElement, ActionResult, Brain, Decision, Driver, ExceptionCode, Facts, Helper, Item, Logger, PlanStep, Task, WindowRef } from "./contracts.ts";
import { stepText } from "./contracts.ts";
import { GATE, isTextInput } from "./decide.ts";
import { openUrl, restoreMinimized, windowsOf } from "./apps.ts";
import { FileOps, finderFolder, listTree, looseFiles, safeRoot } from "./fsops.ts";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { nowIso } from "./logger.ts";
import { FIND_FIELD, goalValues, MESSAGE_FIELD, openOnly, SEND_INTENT } from "./compile.ts";
import { perceive, screenFromMarkdown, screenText, signature, TEXT_INPUT } from "./perceive.ts";
import { clickForbidden, typingForbidden } from "./safety.ts";

export const MAX_STEPS = 25;

export interface TaskCtx {
  runId: string;
  driver: Driver;
  brain: Brain;
  helper: Helper;
  log: Logger;
  signal: AbortSignal;
  win: WindowRef;
  /** when background input is refused (Electron text fields, apps with 2 windows), retry once in the foreground (counted) */
  allowForeground?: boolean;
  maxSteps?: number;
  onUpdate?: (t: Task) => void;
  sleep?: (ms: number) => Promise<void>;
}

const topOf = (p?: Record<string, number>) =>
  p ? Object.entries(p).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(", ") : "";

const BROWSERS = /safari|chrome|brave|arc|edge|firefox|vivaldi|opera/i;
/** apps that open a link of their own (a folder, a maps:// route, a stocks:// symbol) */
const URL_APPS = /^(Finder|Maps|Stocks)$/;

/** browser tabs: AXRadioButtons whose parent is the window itself (Brave, Chrome and Safari all expose them this way) */
function tabsOf(obs?: { elements: any[] }): { label?: string }[] {
  const els = obs?.elements ?? [];
  const byIndex = new Map(els.map((e) => [e.index, e]));
  return els.filter((e) => e.role === "AXRadioButton" && byIndex.get(e.parent)?.role === "AXWindow");
}

export async function runTask(ctx: TaskCtx, task: Task): Promise<Task> {
  const { driver, brain, helper, log, signal } = ctx;
  let win = ctx.win;
  task.windowId = win.windowId;
  const allowForeground = ctx.allowForeground ?? true;
  // set once an app turns out to be slow to read (e.g. Notes with hundreds of notes): a shallower, longer read
  let slowOpts: { timeoutMs: number; maxDepth?: number } | undefined;
  const typedTexts: string[] = []; // what this agent typed; a text area containing it is the agent's own work
  const typedInto = new Map<string, string>(); // field (by position) -> the text typed into it (not again, even if unreadable)
  // a text field is known by its POSITION, and what it is for by the FIRST label it had: some apps rename a field to
  // its contents (WhatsApp: "Name, number, @username" becomes "+91 83096 51677" once typed into)
  const firstLabel = new Map<string, string>();
  /** names compared by their letters and digits only: accessibility spells numbers out ("+ 9 1,8 3 0 9 6,5 1 6 7 7")
   *  and adds marks and punctuation, so "+91 83096 51677" must match "+ 9 1,8 3 0 9 6,5 1 6 7 7, You" */
  const compact = (x: string) => (x ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  /** the open content is about `name`: its title (top of the window, right of any sidebar) starts with it */
  const headed = (o: { elements: AxElement[] }, name: string) => {
    const winEl = o.elements.find((e) => e.role === "AXWindow" && e.frame);
    const W = winEl?.frame;
    return o.elements.some((e) => e.frame && !TEXT_INPUT.has(e.role) && compact(e.label ?? "").startsWith(compact(name)) &&
      (!W || (e.frame.y < W.y + 110 && e.frame.x > W.x + W.w * 0.3)));
  };
  const notReached = new Set<string>(); // clicked, but it did not become the open content
  const fieldKey = (e?: AxElement) => (e?.frame ? `${e.role}@${Math.round(e.frame.x)},${Math.round(e.frame.y)}` : "");
  let lastTyped: { id: string; label: string; text: string; foreground: boolean } | undefined;
  let retyped = false;
  let baseline: string[] | undefined; // the screen text when the task started
  let waitedAfterSend = false;
  let fileOps: FileOps | undefined;
  // opening sites: the browser's tab strip is the ground truth (tabs are AXRadioButtons directly under the window)
  let opened: { expect: number; tabsBefore: number; windowId: number; urls: string[] } | undefined;
  let savedDoc: { path: string; checked: boolean; openedIn?: string } | undefined; // a document saved by code (save_as)
  let safetyReplans = 0;
  const searchedFor = new Set<string>(); // things the agent already searched for (once each)
  const reached = new Set<string>(); // things the goal asks to reach that the agent already clicked (once each)
  const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = ctx.maxSteps ?? MAX_STEPS;
  const agent = task.agent;
  const t0 = performance.now();
  task.status = "running";
  const update = (now?: string) => {
    task.now = now;
    task.seconds = (performance.now() - t0) / 1000;
    ctx.onUpdate?.(task);
  };
  const finish = (code: ExceptionCode | null, reason = "", answer?: string): Task => {
    task.seconds = (performance.now() - t0) / 1000;
    task.status = code ? "failed" : "done";
    if (code) task.exception = { code, reason };
    if (answer !== undefined) task.answer = answer;
    task.now = undefined;
    log.write({ type: "task_end", runId: ctx.runId, t: nowIso(), task });
    ctx.onUpdate?.(task);
    return task;
  };

  const prev: string[] = [];
  const tried: string[] = [];
  let lastSig = "";
  let focusOnly = false; // the last action only put the cursor in a text field (nothing visible is expected to change)
  let idle = 0;
  let repeats = 0;
  let notDone = 0;
  let notDoneReason: string | undefined;
  let plan: PlanStep[] | undefined;
  let planPos = 0;
  const usePlan = brain.kind === "jev"; // the LLM arm decides every step itself, like a normal LLM agent
  let freeMode = false; // no plan available: jev decides step by step from the goal alone
  const planActive = () => usePlan && !!plan && !freeMode;

  const makePlan = async (screen: string[], items: Item[], why?: string, obsForFiles?: { elements: unknown[] }) => {
    update(why ? "re-planning" : "planning");
    // Finder: the compiler needs the real file names (from the file system, not from Finder's view)
    let files: string[] | undefined;
    if (task.app === "Finder" && obsForFiles) {
      const dir = finderFolder(obsForFiles as any);
      if (dir && !safeRoot(dir)) files = looseFiles(dir);
    }
    const r = await helper.plan(task.goal, task.app, screen, items, why, files);
    task.counts.helperCalls++;
    task.cost.helperUsd += r.costUsd;
    plan = r.steps;
    planPos = 0;
    // several explicit moves -> one sort_into: the cheap classifier decides each file's folder (and may leave unclear ones)
    const moves = plan.filter((s) => s.action === "move_file");
    const folders = plan.filter((s) => s.action === "make_folder").map((s) => s.text ?? "").filter(Boolean);
    if (brain.choose && moves.length >= 3 && folders.length >= 2) {
      plan = [{ action: "sort_into", text: [...new Set([...folders, ...moves.map((m) => m.text ?? "")])].filter(Boolean).join(", ") }];
    }
    // SAFETY, in code: a task that CREATES something in a window showing existing content starts with the app's
    // own "New ..." button (New Note, New Document, ...) even if the planner forgot it
    const creates = /\b(create|write|make|new|add|draft|compose)\b/i.test(task.goal);
    const existing = items.some((i) => i.role === "AXTextArea" && i.state === "filled");
    const newBtn = items.find((i) => (i.role === "AXButton" || i.role === "AXMenuButton") && /^new\b/i.test(i.text));
    const willType = plan.some((s) => s.action === "type"); // only matters when the agent is about to WRITE text
    if (creates && willType && existing && newBtn && !plan.some((s) => s.action === "click" && /^new\b/i.test(s.target ?? ""))) {
      plan.unshift({ action: "click", target: newBtn.text });
    }
    task.plan = plan;
    freeMode = plan.length === 0 && helper.lastSource === "none";
    const source = helper.lastSource ? `[${helper.lastSource}] ` : "";
    log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "plan", detail: source + (plan.length ? plan.map(stepText).join(" → ") : "(no plan: jev decides step by step)"), costUsd: r.costUsd, ms: r.ms });
  };

  // every LLM call is recorded with the reason it was needed. A pure-LLM helper (HELPER=haiku) counts every call.
  const llmHelper = helper.canEscalate === undefined;
  const noteLlm = (what: string) => task.llmCalls.push(what);
  let escalations = 0;
  let curObs: { elements: unknown[] } | undefined;
  /** jev is stuck: ask the LLM for a plan from the CURRENT screen, once or twice per task. false = no LLM available */
  const escalate = async (p: { screen: string[]; items: Item[] }, reason: string): Promise<boolean> => {
    if (!usePlan || llmHelper || !helper.canEscalate || escalations >= 2) return false;
    escalations++;
    noteLlm(`plan (jev stuck: ${reason.slice(0, 90)})`);
    await makePlan(p.screen, p.items, `jev was stuck: ${reason}`, curObs).catch(() => {});
    idle = 0; repeats = 0; tried.length = 0; freeMode = false;
    return (plan?.length ?? 0) > 0;
  };

  /**
   * Browsers: the page text must belong to the tab the window shows. Safari sometimes keeps exposing ANOTHER tab's page
   * (seen in tests: window titled "how tall Lion Rock…", page text from an older "population of Hong Kong" tab), and
   * the agent would then read and verify the wrong page. Compare the live window title with the page's title; on a
   * mismatch, wait and re-read, then press the browser's Reload button once.
   */
  const freshPage = async (o: Awaited<ReturnType<Driver["observe"]>>) => {
    const key = (s?: string) => (s ?? "").toLowerCase().replace(/\s+-\s+(brave|google chrome|chrome|safari|arc)$/i, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 30);
    const liveTitle = async () => (await driver.listWindows().catch(() => ({ windows: [] as any[] }))).windows.find((w: any) => w.window_id === win.windowId)?.title as string | undefined;
    const matches = (x: typeof o, title?: string) => {
      const page = x.elements.find((e) => e.role === "AXWebArea")?.label;
      return !title || !page ? !title || page !== undefined : key(page) === key(title) || key(title).startsWith(key(page)) || key(page).startsWith(key(title));
    };
    let title = await liveTitle();
    if (title) o = { ...o, window: { ...o.window, title } };
    for (let attempt = 0; attempt < 4 && !matches(o, title); attempt++) {
      if (attempt === 2) {
        const reload = o.elements.find((e) => e.role === "AXButton" && /^reload( this page)?$/i.test(e.label ?? "") && e.token);
        if (reload?.token) { update("the page shown is stale: reloading"); await driver.click(agent, win, reload.token).catch(() => {}); task.counts.actions++; }
      } else update("waiting for the page to load");
      await sleep(attempt === 2 ? 2000 : 1000);
      const again = await driver.observe(agent, win, slowOpts);
      title = (await liveTitle()) ?? title;
      if (again.elements.length) o = { ...again, window: { ...again.window, title: title ?? again.window.title } };
    }
    return o;
  };

  /** returns the finished task if the goal is achieved (or given up on), undefined to keep going */
  const checkDone = async (p: { screen: string[]; items: Item[] }, step: number, why: string): Promise<Task | undefined> => {
    update("checking the result");
    // a planned save is part of the goal: not done until the file is saved
    if (!savedDoc && plan?.some((s, i) => s.action === "save_as" && i >= planPos)) return undefined;
    // a document saved in code is checked in code: the file exists and holds the text from the window
    if (savedDoc && plan?.length && planPos >= plan.length) {
      if (savedDoc.checked) return finish(null, "", `saved ${savedDoc.path.replace(homedir(), "~")}${savedDoc.openedIn ? ` and opened it in ${savedDoc.openedIn}` : ""}`);
      return finish("not_achieved", `the document was not saved correctly: ${savedDoc.path}`);
    }
    // a plan that only OPENS sites is checked by counting tabs, not by reading the page (a window title shows one tab only)
    // (never for a question: "find how tall X is" also compiles to one open step, but it needs the answer read off the page)
    if (opened && plan?.length && plan.every((s) => s.action === "open_url") && opened.windowId === win.windowId && openOnly(task.goal)) {
      const tabs = tabsOf(curObs as any);
      const added = tabs.length - opened.tabsBefore;
      if (added >= opened.expect) {
        const titles = tabs.slice(-opened.expect).map((t) => t.label ?? "").join(" | ");
        log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `${why} → achieved: ${added} new tab(s) in the window (checked in code: ${titles.slice(0, 200)})`, costUsd: 0, ms: 0 });
        const where = opened.tabsBefore === 0 ? "in a new window" : "as new tabs";
        return finish(null, "", `opened ${where}: ${opened.urls.map((u) => u.replace(/^https?:\/\//, "")).join(", ")}`.slice(0, 300));
      }
      // fewer tabs than asked (e.g. Safari hides the tab strip for a single tab): fall through to the verifier
    }
    // for file tasks the file system itself is the ground truth: give the verifier the real folder contents
    const evidence = fileOps ? [`(contents of ${fileOps.root}, read from the file system:)`, ...listTree(fileOps.root)] : [];
    const v = await helper.verify(task.goal, [...evidence, ...p.screen], p.items, baseline, { acted: task.counts.actions > 0 });
    task.counts.helperCalls++;
    task.cost.helperUsd += v.costUsd;
    if (v.llm || llmHelper) noteLlm(llmHelper ? "verify" : "verify (jev borderline)");
    log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "verify", detail: `${why} → ${v.achieved ? "achieved" : "NOT achieved"}: ${v.answer} (${v.reason})`, costUsd: v.costUsd, ms: v.ms });
    if (v.achieved) {
      // cache an LLM plan only if the agent really executed all of it (a "success" with nothing done must not be cached)
      if (usePlan && plan?.length && helper.lastSource === "llm" && task.counts.actions > 0 && planPos >= plan.length) helper.remember?.(task.app, task.goal, plan);
      return finish(null, "", v.answer);
    }
    notDone++;
    notDoneReason = v.reason;
    prev.push(`(checked: the screen does not show the goal achieved yet: ${v.reason})`);
    if (notDone >= 3) return finish("not_achieved", `the screen does not show the goal achieved: ${v.reason}`);
    if (usePlan) {
      if (llmHelper) { noteLlm("re-plan"); await makePlan(p.screen, p.items, v.reason).catch(() => {}); }
      else if (!(await escalate(p, `not done yet: ${v.reason}`))) { freeMode = true; plan = []; planPos = 0; } // no LLM: jev carries on alone
    }
    return undefined;
  };

  for (let step = 1; step <= max; step++) {
    if (signal.aborted) return finish("stopped", "stopped by the user");
    task.steps = step;

    update("reading the window");
    let obs = await driver.observe(agent, win, slowOpts);
    const learnFields = (o: typeof obs) => { for (const e of o.elements) if (TEXT_INPUT.has(e.role) && e.frame && !firstLabel.has(fieldKey(e))) firstLabel.set(fieldKey(e), e.label ?? ""); };
    learnFields(obs);
    if (obs.truncated && !slowOpts && !BROWSERS.test(task.app)) {
      // the accessibility walk ran out of time (it gets lost in long lists): read the top levels only, with more time.
      // Measured on Notes with many notes: depth 4 = 3.8 s and complete (toolbar + note body); depth 6+ timed out at 10 s.
      // "truncated" also means "hit the element cap" (a long web page): a shallower read must be complete or read more.
      // Browsers never take this path: a depth-3 read of a web page is just the window frame (Wikipedia: 3 lines).
      update("reading the window (slow app)");
      const full = obs;
      let best = obs;
      for (const maxDepth of [4, 3]) {
        const o = await driver.observe(agent, win, { timeoutMs: 10000, maxDepth });
        // a COMPLETE read wins (Notes: depth 4 is complete, the full read timed out); among cut-off reads, the larger one
        const better = (!o.truncated && best.truncated) || (o.truncated === best.truncated && o.elements.length > best.elements.length);
        if (better && o.elements.length) { best = o; slowOpts = { timeoutMs: 10000, maxDepth }; }
        if (!o.truncated) break;
      }
      obs = best;
      if (best === full) slowOpts = { timeoutMs: 10000 }; // the full read was the best: keep reading fully, with more time
    }
    for (let retry = 0; obs.elements.length === 0 && retry < 2; retry++) {
      // often transient (an app that was just brought forward and back, a window still opening): wait, re-pick, re-read
      await sleep(900);
      await restoreMinimized(task.app).catch(() => false); // the user minimised it during the task
      const ws = await windowsOf(driver, task.app).catch(() => [] as WindowRef[]);
      // the same window again after a failed read only if there is no other one
      win = (retry === 0 ? ws.find((w) => w.windowId === win.windowId) : ws.find((w) => w.windowId !== win.windowId)) ?? ws[0] ?? win;
      task.windowId = win.windowId;
      obs = await driver.observe(agent, win, slowOpts);
    }
    if (obs.elements.length === 0) {
      return finish("window_lost", `could not read the ${task.app} window (${obs.degraded ?? "empty"}). Is it closed, minimised, or in full screen?`);
    }
    if (BROWSERS.test(task.app) && opened) obs = await freshPage(obs); // only pages the agent opened (never reload the user's page)
    const nextStep = planActive() ? plan![planPos] : undefined;
    const p = perceive(obs, task.goal, undefined, nextStep?.target ?? "");
    if (!baseline) baseline = p.screen;
    const sig = signature(p);
    if (sig === lastSig) { if (!focusOnly) idle++; }
    else {
      idle = 0;
      tried.length = 0;
    }
    focusOnly = false;
    lastSig = sig;
    if (idle >= 3 && !(await escalate(p, "three actions changed nothing on screen"))) return finish("stalled", "three actions in a row changed nothing on screen");

    curObs = obs;
    if (usePlan && !plan) {
      try {
        if (llmHelper) noteLlm("plan");
        await makePlan(p.screen, p.items, undefined, obs);
      } catch (e: any) {
        return finish("error", `planning failed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    if (signal.aborted) return finish("stopped", "stopped by the user"); // stop as soon as possible: planning and reading take seconds
    // the plan is finished: check the screen directly (no classifier call needed). If the last action SENT something
    // (Enter / confirm), give the app a moment to answer first (chat apps reply after a few seconds)
    if (planActive() && planPos >= plan!.length && !waitedAfterSend && /^(press return|confirm )/.test(prev[prev.length - 1] ?? "")) {
      waitedAfterSend = true;
      update("waiting for the app to respond");
      await sleep(3000);
      continue;
    }
    if (planActive() && planPos >= plan!.length) {
      const r = await checkDone(p, step, "plan finished");
      if (r) return r;
      continue;
    }

    // a planned open_url needs no decision: the code opens the address without the keyboard
    if (planActive() && plan![planPos]?.action === "open_url" && !(BROWSERS.test(task.app) || URL_APPS.test(task.app))) {
      // an LLM plan once tried to "open icloud.com/pages" inside Notes: addresses only open in a browser or Finder
      const skipDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: "open_url", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: skipDec, acted: `skipped: open url only works in a browser or Finder, not in ${task.app}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
      planPos++;
      continue;
    }
    if (planActive() && plan![planPos]?.action === "save_as") {
      // scripted (disclosed): the text in THIS window is converted by macOS's textutil into a real document file
      const fmt = /^(docx|doc|rtf|odt|html)$/i.test(plan![planPos]!.text ?? "") ? plan![planPos]!.text!.toLowerCase() : "docx";
      const codeDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: "save_as", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
      const t1 = performance.now();
      const area = obs.elements.filter((e) => e.role === "AXTextArea" && (e.value ?? "").trim()).sort((a, b) => (b.value?.length ?? 0) - (a.value?.length ?? 0))[0];
      const content = area?.value ?? "";
      let acted: string;
      if (!content.trim()) acted = "blocked: there is no text in the window to save";
      else {
        const title = (content.split("\n").find((l) => l.trim()) ?? "Document").replace(/[\/:*?"<>|#]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Document";
        const dir = join(homedir(), "Documents", "Backstage");
        mkdirSync(dir, { recursive: true });
        let path = join(dir, `${title}.${fmt}`);
        for (let n = 2; existsSync(path); n++) path = join(dir, `${title} ${n}.${fmt}`); // never overwrite
        const tmp = join(import.meta.dir, "..", "runs", ctx.runId, `${task.id}-save.txt`);
        mkdirSync(join(import.meta.dir, "..", "runs", ctx.runId), { recursive: true });
        writeFileSync(tmp, content);
        const conv = Bun.spawnSync(["textutil", "-convert", fmt, "-output", path, tmp]);
        // read the saved file back: it must hold the text from the window
        const back = existsSync(path) ? Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", path]).stdout.toString() : "";
        const checked = conv.exitCode === 0 && norm(back).includes(norm(content).slice(0, 80));
        savedDoc = { path, checked };
        task.counts.scripted++;
        task.counts.actions++;
        acted = checked ? `saved the text as ${path.replace(homedir(), "~")} (scripted: textutil, read back and checked)` : `saving as ${fmt} FAILED (${conv.stderr.toString().slice(0, 100)})`;
        const viewer = plan![planPos]!.target;
        if (checked && viewer) {
          const app = (await driver.listApps().catch(() => [])).find((a) => a.name === viewer);
          if (app) {
            await driver.launchApp(agent, app.bundle_id, [path]).catch(() => {});
            savedDoc.openedIn = viewer;
            acted += `, opened in ${viewer} (background)`;
          }
        }
      }
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (!savedDoc) return finish("not_achieved", acted);
      continue;
    }
    if (planActive() && plan![planPos]?.action === "open_url" && plan![planPos]!.text && task.bundleId) {
      const url = plan![planPos]!.text!;
      update(`opening ${url}`);
      const t1 = performance.now();
      let acted = `open ${url}`;
      const tabsHere = tabsOf(obs).length, winHere = win.windowId;
      try {
        // opening can wait several seconds for the page: "stop" doesn't wait for it
        const stopped = new Promise<"stopped">((res) => (signal.aborted ? res("stopped") : signal.addEventListener("abort", () => res("stopped"), { once: true })));
        const r = await Promise.race([openUrl(driver, agent, { name: task.app, bundle_id: task.bundleId, running: true }, url, plan![planPos]!.target === "new window"), stopped]);
        if (r === "stopped") return finish("stopped", "stopped by the user");
        win = r.win;
        task.windowId = win.windowId;
        if (r.tookFront) { task.counts.foreground++; acted += " (the browser came to the front; your app was put back)"; }
        task.counts.actions++;
        const urls = url.split(/\s+/).filter(Boolean);
        const same = opened?.windowId === winHere;
        opened = r.win.windowId === winHere
          ? { expect: (same ? opened!.expect : 0) + urls.length, tabsBefore: same ? opened!.tabsBefore : tabsHere, windowId: winHere, urls: [...(same ? opened!.urls : []), ...urls] }
          : { expect: urls.length, tabsBefore: 0, windowId: r.win.windowId, urls }; // a new window: every tab in it was opened now
      } catch (e: any) {
        acted = `open ${url} FAILED: ${String(e?.message ?? e).slice(0, 120)}`;
      }
      const codeDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: "open_url", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      if (task.app === "Maps" && /daddr=/.test(url)) {
        // a background Maps window takes 3-11 s to show a new route, and shows the OLD route's time meanwhile: wait for
        // the destination to be filled in and a travel time that wasn't there before (or any time after 6 s: same route)
        update("waiting for Maps to plan the route");
        const dest = decodeURIComponent(url.match(/daddr=([^&]+)/)![1]!).toLowerCase();
        const TIME = /\b\d+\s*(min|hr|h)\b/i;
        const oldTimes = new Set(p.screen.filter((l) => TIME.test(l)));
        const t2 = performance.now();
        while (performance.now() - t2 < 15000 && !signal.aborted) {
          await sleep(1000);
          const o = await driver.observe(agent, win);
          const lines = o.markdown ? screenFromMarkdown(o.markdown) : screenText(o.elements);
          const hasDest = lines.some((l) => l.toLowerCase().includes(dest));
          const times = lines.filter((l) => TIME.test(l));
          if (hasDest && (times.some((l) => !oldTimes.has(l)) || (times.length && performance.now() - t2 > 6000))) break;
        }
        continue;
      }
      await sleep(task.app === "Stocks" ? 2000 : 1200); // let the page start loading
      continue;
    }

    // Weather: switch to a city in code (the search lists airports and look-alikes first; jev and the LLM both
    // picked "Hong Kong International Airport" or nothing): clear the search, type the city, pick the result that
    // STARTS with the city's name and isn't an airport
    if (planActive() && plan![planPos]?.action === "pick_city" && task.app === "Weather") {
      const city = plan![planPos]!.text ?? "";
      const t1 = performance.now();
      update(`looking up ${city}`);
      let acted = `searched Weather for ${city}: no search field`;
      const isField = (e: AxElement) => (e.role === "AXTextField" || e.role === "AXSearchField") && !!e.token;
      let field = obs.elements.find(isField);
      if (field?.token) {
        const clear = obs.elements.find((e) => e.role === "AXButton" && /^clear text$/i.test(e.label ?? "") && e.token);
        if (clear?.token) {
          await driver.click(agent, win, clear.token);
          await sleep(300);
          field = (await driver.observe(agent, win)).elements.find(isField) ?? field; // the cleared field is a new element
        }
        // put the cursor in the field first: text typed into an unfocused search field goes nowhere (reported as ok)
        await driver.click(agent, win, field.token!);
        await sleep(300);
        field = (await driver.observe(agent, win)).elements.find(isField) ?? field;
        await driver.typeText(agent, win, field.token!, city);
        await driver.pressKey(agent, win, "return", field.token);
        task.counts.actions += 2;
        acted = `searched Weather for ${city}: no matching result`;
        const want = city.toLowerCase();
        for (let i = 0; i < 8; i++) {
          await sleep(500);
          const o = await driver.observe(agent, win);
          const text = (e: AxElement) => (e.label || e.value || "").trim();
          const match = o.elements
            .filter((e) => /^AX(Button|Cell|Row|StaticText|GenericElement)$/.test(e.role) && text(e).toLowerCase().startsWith(want) && !/airport/i.test(text(e)))
            .sort((a, b) => text(a).length - text(b).length)[0];
          // the matching text may be a plain label inside a clickable row: click the nearest clickable ancestor
          let hit: AxElement | undefined = match;
          for (let k = 0; hit && !hit.token && k < 4; k++) hit = hit.parent !== undefined ? o.elements.find((e) => e.index === hit!.parent) : undefined;
          if (match && hit?.token) {
            await driver.click(agent, win, hit.token);
            task.counts.actions++;
            acted = `searched Weather for ${city} and opened "${text(match)}"`;
            // a city not seen before fetches its forecast first: wait for "<City>, 21 degrees …" (up to 8 s)
            for (let j = 0; j < 16; j++) {
              await sleep(500);
              const f = await driver.observe(agent, win);
              if (f.elements.some((e) => text(e).toLowerCase().startsWith(want) && /\bdegrees?\b|°/i.test(text(e)))) break;
            }
            break;
          }
        }
      }
      const codeDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: "pick_city", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted);
      planPos++;
      continue;
    }

    // Finder file steps: scripted (disclosed), confined to the folder this window shows
    const fstep = planActive() ? plan![planPos] : undefined;
    if (fstep && (fstep.action === "make_folder" || fstep.action === "move_file" || fstep.action === "sort_into")) {
      const t1 = performance.now();
      const lines: string[] = [];
      const codeDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: fstep.action, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
      if (!fileOps) {
        const dir = finderFolder(obs);
        const why = dir ? safeRoot(dir) : "could not read the folder from Finder's path bar (View › Show Path Bar)";
        if (!dir || why) {
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted: `refused: ${why}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
          return finish("driver_refused", `file organising refused: ${why}`);
        }
        fileOps = new FileOps(dir, join(import.meta.dir, "..", "runs", ctx.runId), task.id);
      }
      if (fstep.action === "make_folder") {
        const r = fileOps.makeFolder(fstep.text ?? "");
        lines.push(r.detail);
        if (r.ok) task.counts.scripted++;
      } else if (fstep.action === "move_file") {
        const r = fileOps.moveFile(fstep.target ?? "", fstep.text ?? "");
        lines.push(r.detail);
        if (r.ok) task.counts.scripted++;
      } else {
        // sort_into: the cheap classifier decides, file by file, which folder each one belongs in
        const cats = (fstep.text ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (looseFiles(fileOps.root).length === 0) {
          // nothing to sort: say so honestly instead of creating empty folders and asking an LLM to re-plan
          const inside = listTree(fileOps.root).slice(0, 8).join("; ");
          const msg = `nothing to sort: there are no loose files in ${fileOps.root.split("/").pop()} (everything is already inside subfolders: ${inside})`;
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted: `scripted sort_into: ${msg}`, results: [], ms: { observe: obs.ms, decide: 0, act: 0 } });
          return finish(null, "", msg);
        }
        for (const c of cats) {
          const r = fileOps.makeFolder(c);
          lines.push(r.detail);
          if (r.ok && r.detail.startsWith("created")) task.counts.scripted++;
        }
        // the file list comes from the file system, not from Finder's current view (icon / list / column)
        const files = looseFiles(fileOps.root).map((name) => ({ text: name }));
        const left: string[] = [];
        const moved: string[] = [];
        const options: Record<string, string> = Object.fromEntries(cats.map((c) => [c, `the "${c}" folder`]));
        options.leave_in_place = "Leave it where it is: none of the folders fits, or it is unclear";
        for (const f of files) {
          if (signal.aborted) break;
          if (!brain.choose) { lines.push(`no classifier for "${f.text}": left in place`); left.push(f.text); continue; }
          update(`sorting ${f.text}`);
          const c = await brain.choose(
            `Which folder should the file "${f.text}" be moved into, to achieve the goal: ${task.goal}`,
            options,
            { goal: task.goal, file_name: f.text, folders: cats },
          );
          task.counts.decisions++;
          task.cost.decisionsUsd += c.costUsd;
          task.decideMs.push(c.ms);
          if (c.choice === "leave_in_place" || (brain.kind === "jev" && c.confidence < GATE)) {
            const why = c.choice === "leave_in_place" ? "no folder fits" : `unsure: confidence ${c.confidence.toFixed(2)}`;
            lines.push(`left "${f.text}" in place (${why})`);
            left.push(`${f.text} (${why})`);
            continue;
          }
          const r = fileOps.moveFile(f.text, c.choice);
          lines.push(`${r.detail} (confidence ${c.confidence.toFixed(2)}, ${c.ms} ms)`);
          if (r.ok) { task.counts.scripted++; moved.push(`${f.text} → ${c.choice}`); }
          else left.push(`${f.text} (${r.detail})`);
        }
        // deterministic check: the file system is the ground truth; every file is moved or explicitly left with a reason
        const loose = looseFiles(fileOps.root);
        const unexplained = loose.filter((n) => !left.some((l) => l.startsWith(n + " ")));
        const acted = `scripted sort_into: ${lines.join("; ")}`;
        log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
        if (files.length && !unexplained.length && (plan?.length ?? 0) === planPos + 1) {
          const summary = `${moved.length} file(s) moved: ${moved.join(", ") || "none"}.${left.length ? ` Left in place: ${left.join(", ")}.` : ""} Undo script: ${fileOps.undoFile}`;
          return finish(null, "", summary);
        }
        prev.push(acted.slice(0, 400));
        planPos++;
        await sleep(800);
        continue;
      }
      const acted = `scripted ${fstep.action}: ${lines.join("; ")}`;
      log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
      prev.push(acted.slice(0, 400));
      planPos++;
      await sleep(800); // Finder refreshes the window
      continue;
    }

    if (signal.aborted) return finish("stopped", "stopped by the user");

    // what the agent needs isn't on screen, but there is a search field: search for it (what a person does) instead
    // of clicking whatever else is there. "What it needs": the plan's next click, or what the goal asks to reach
    // ("message Sohan", "reply to Sohan", "open the chat with Mum").
    {
      const low = compact;
      const words = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
      const next = planActive() ? plan![planPos] : undefined;
      const wanted = next?.action === "click" && next.target ? [next.target] : !planActive() ? goalValues(task.goal).targets : [];
      // on screen = a control whose label STARTS with it (a mention inside some message text doesn't count)
      // (a text field counts by its LABEL only: a search box that contains the name doesn't mean the name is shown)
      const shown = (w: string) => obs.elements.some((e) => e.token && low(TEXT_INPUT.has(e.role) ? firstLabel.get(fieldKey(e)) ?? e.label ?? "" : `${e.label || e.value || ""}`).startsWith(low(w)));
      const missing = wanted.find((w) => low(w).length >= 2 && (!shown(w) || notReached.has(low(w))) && !searchedFor.has(low(w)));
      const isFind = (e: AxElement) => !!e.token && (e.role === "AXSearchField" || (TEXT_INPUT.has(e.role) && FIND_FIELD.test(e.label ?? "")));
      let search = missing ? obs.elements.find(isFind) : undefined;
      // many apps show no search FIELD until a Search control is pressed (or a New chat / New message sheet opens).
      // Try each way in until one gives a field the agent can type into (WhatsApp's "Search" focuses a field that
      // isn't exposed to accessibility at all; its New Chat sheet has a real one)
      if (missing && !search) {
        let o2 = obs;
        for (const re of [/^(search|find)\b/, /^(new (chat|message|conversation)|compose|start a (chat|conversation))\b/]) {
          const open = o2.elements.find((e) => e.token && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && (e.frame?.w ?? 0) > 0 && re.test(words(e.label || e.value || "")));
          if (!open?.token) continue;
          update(`opening search to find ${missing}`);
          await driver.click(agent, win, open.token);
          task.counts.actions++;
          await sleep(600);
          o2 = await driver.observe(agent, win);
          search = o2.elements.find(isFind) ?? o2.elements.find((e) => !!e.token && TEXT_INPUT.has(e.role) && !MESSAGE_FIELD.test(e.label ?? ""));
          prev.push(`pressed '${open.label}' to get a search field${search ? "" : " (no field appeared)"}`);
          if (search) break;
        }
      }
      // what the goal asks to reach IS on screen: click it (the biggest element starting with its name: the list row
      // or search result, not the search box that contains the name, nor a small header title with the same name)
      const reachable = !missing && !planActive() ? wanted.find((w) => low(w).length >= 2 && shown(w) && !reached.has(low(w))) : undefined;
      if (reachable) {
        const hit = obs.elements
          .filter((e) => e.token && e.frame && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && low(e.label || e.value || "").startsWith(low(reachable)))
          .sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0];
        if (hit?.token) {
          reached.add(low(reachable));
          update(`opening ${reachable}`);
          const t1 = performance.now();
          const r = await driver.click(agent, win, hit.token);
          task.counts.actions++;
          await sleep(700);
          // did it become the open content? if not, it counts as not found (the agent searches for it next)
          const ok = headed(await driver.observe(agent, win), reachable);
          if (!ok) notReached.add(low(reachable));
          const acted = ok ? `opened '${(hit.label || hit.value || "").slice(0, 60)}' (what the goal asks to reach)` : `clicked '${(hit.label || hit.value || "").slice(0, 60)}' but ${reachable} did not open`;
          const codeDec: Decision = { kind: "click", kindConf: 1, gate: 1, backend: "code", model: "reach", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
          log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [r], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
          prev.push(acted);
          await sleep(800);
          continue;
        }
      }
      if (missing && search?.token) {
        searchedFor.add(low(missing));
        update(`searching for ${missing}`);
        const t1 = performance.now();
        await driver.click(agent, win, search.token);
        if ((search.value ?? "").trim() && !/^search$/i.test((search.value ?? "").trim())) await driver.setValue(agent, win, search.token, "").catch(() => undefined);
        await driver.typeText(agent, win, search.token, missing);
        task.counts.actions += 2;
        let acted = `searched for "${missing}" (it was not on screen) in '${search.label ?? "search"}'`;
        // a search isn't done until a result is opened: the biggest element that starts with the name (results are often
        // plain text rows that aren't in the agent's list of buttons)
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          const o3 = await driver.observe(agent, win);
          const hit = o3.elements
            .filter((e) => e.token && e.frame && !TEXT_INPUT.has(e.role) && e.role !== "AXMenuItem" && low(e.label || e.value || "").startsWith(low(missing)))
            .sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0];
          if (hit?.token) {
            await driver.click(agent, win, hit.token);
            task.counts.actions++;
            acted += `, opened '${(hit.label || hit.value || "").slice(0, 60)}'`;
            reached.add(low(missing));
            break;
          }
        }
        const codeDec: Decision = { kind: "type_text", kindConf: 1, gate: 1, backend: "code", model: "search", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 };
        log.write({ type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: codeDec, acted, results: [], ms: { observe: obs.ms, decide: 0, act: Math.round(performance.now() - t1) } });
        prev.push(acted);
        await sleep(800);
        continue;
      }
    }

    update("deciding");
    const facts: Facts = { goal: task.goal, app: task.app, screenText: p.screen, previousActions: prev, alreadyTriedHere: [...tried], notDoneReason, plan, planPos };
    let dec: Decision;
    try {
      dec = await brain.classify(facts, p.items);
    } catch (e: any) {
      return finish("error", `${brain.kind} brain failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    task.counts.decisions++;
    task.cost.decisionsUsd += dec.costUsd;
    task.decideMs.push(dec.ms);
    const chosen: Item | undefined = dec.item === undefined ? undefined : p.items.find((i) => i.i === dec.item);

    const logStep = (acted: string, results: ActionResult[], actMs: number) =>
      log.write({
        type: "step", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, step, items: p.items, decision: dec, acted, results,
        ms: { observe: obs.ms, decide: dec.ms, act: Math.round(actMs) }, truncated: obs.truncated,
      });
    // background input refused (Electron text fields, apps with several windows): one counted foreground retry
    const refusedInBackground = (r?: ActionResult) =>
      !!r && !r.ok && (r.error?.code === "background_unavailable" || r.error?.code === "keyboard_ambiguity" || r.error?.code === "minimized_or_hidden");

    // ---- the gate: only for the calibrated brain (jev). An LLM's self-reported confidence is not calibrated. ----
    if (dec.backend === "jev" && !["done", "wait", "none"].includes(dec.kind) && dec.gate < GATE) {
      task.counts.gated++;
      logStep(`gated: confidence ${dec.gate.toFixed(2)} < ${GATE} (${topOf(dec.kindP)}; ${topOf(dec.itemP)})`, [], 0);
      if (await escalate(p, `unsure what to do next (confidence ${dec.gate.toFixed(2)})`)) continue;
      return finish("low_confidence", `not sure what to do next (confidence ${dec.gate.toFixed(2)}). It stopped instead of guessing.`);
    }
    if (dec.kind === "none") {
      if (dec.backend === "jev" && dec.kindConf < 0.5) {
        // unsure "nothing helps" usually means "it's already done": let the verifier read the screen
        logStep(`unsure (none ${dec.kindConf.toFixed(2)}): checking the screen`, [], 0);
        const r = await checkDone(p, step, "classifier unsure");
        if (r) return r;
        continue;
      }
      logStep("nothing on screen helps", [], 0);
      if (await escalate(p, "jev sees nothing on screen that helps")) continue;
      return finish("stalled", "nothing on this screen can make progress toward the goal");
    }

    const key = `${dec.kind}:${chosen?.id ?? ""}`;
    if (tried.includes(key) && dec.kind !== "wait" && dec.kind !== "done") {
      repeats++;
      if (repeats >= 2) {
        logStep(`repeat: ${key}`, [], 0);
        if (await escalate(p, `kept choosing ${dec.kind} ${chosen?.text ?? ""} on an unchanged screen`)) continue;
        return finish("stalled", `kept choosing the same action on an unchanged screen (${dec.kind} ${chosen?.text ?? ""})`);
      }
    }
    tried.push(key);

    // ---- done? the verifier reads the screen; a premature "done" is caught here ----
    if (dec.kind === "done") {
      logStep("done? checking the screen", [], 0);
      const r = await checkDone(p, step, "classifier says done");
      if (r) return r;
      continue;
    }

    update(`${dec.kind}${chosen ? " " + chosen.text : ""}`);
    /**
     * Cua drops a window's snapshot after a while (seen: a long itinerary took the writer several seconds, then typing
     * failed with "element_token is stale"): read the window again, find the SAME control (role + label), retry once.
     */
    const retryStale = async (r: ActionResult, again: (token: string) => Promise<ActionResult>): Promise<ActionResult> => {
      if (r.ok || r.error?.code !== "stale_element_token" || !chosen) return r;
      const fresh = perceive(await driver.observe(agent, win, slowOpts), task.goal);
      const same = fresh.items.find((i) => i.role === chosen.role && i.text === chosen.text && i.token) ?? fresh.items.find((i) => i.role === chosen.role && i.token && chosen.role === "AXTextArea");
      return same?.token ? again(same.token) : r;
    };
    let results: ActionResult[] = [];
    let desc = "";
    let holdPlan = false;
    const t1 = performance.now();
    switch (dec.kind) {
      case "click": {
        if (!chosen?.token) { desc = "blocked: no such control"; break; }
        // already the open content (the chat with X is open, X is clicked again): that step is already done
        if (planActive() && plan![planPos]?.action === "click" && goalValues(task.goal).targets.some((t) => compact(t) === compact(chosen.text) || compact(chosen.text).startsWith(compact(t))) && goalValues(task.goal).targets.some((t) => headed(obs, t))) {
          desc = `skipped: '${chosen.text}' is already open`;
          planPos = Math.min(planPos + 1, plan!.length);
          holdPlan = true;
          focusOnly = true;
          break;
        }
        if (isTextInput(chosen)) focusOnly = true; // a click into a text field only focuses it
        // several clickable elements with the same label, of ANY role (WhatsApp: the chat-list row is a 460-pt text
        // element "Sohan", the chat header a 51-pt button "Sohan" that opens the contact's info): the biggest one is
        // the item itself; a title or a badge with the same text is small
        const twins = obs.elements.filter((e) => e.token && !TEXT_INPUT.has(e.role) && e.frame && compact(e.label ?? "") === compact(chosen.text));
        if (twins.length > 1) chosen.token = twins.sort((a, b) => b.frame!.w * b.frame!.h - a.frame!.w * a.frame!.h)[0]!.token;
        // SAFETY: a Send button only when the goal asks to send something
        if (/^send\b/i.test(chosen.text.trim()) && !SEND_INTENT.test(task.goal)) { desc = "blocked: the goal does not ask to send anything"; break; }
        // SAFETY: nothing that spends money or can't be undone unless the goal asks for exactly that
        const risky = clickForbidden(chosen.text, task.goal);
        if (risky) { desc = `blocked: ${risky}`; break; }
        results = [await retryStale(await driver.click(agent, win, chosen.token!), (t) => driver.click(agent, win, t))];
        desc = `click '${chosen.text}'`;
        break;
      }
      case "type_text": {
        if (!isTextInput(chosen) || !chosen?.token) { desc = `blocked: '${chosen?.text ?? "?"}' is not a text field`; break; }
        // SAFETY: never a password, card number or ID: the user does that part
        const secret = typingForbidden(chosen.text);
        if (secret) return finish("not_achieved", secret);
        // SAFETY: never add to text the agent did not write (e.g. the body of one of the user's existing notes)
        const editAllowed = /\b(edit|append|add to|update|change|existing|reply)\b/i.test(task.goal);
        const own = typedTexts.some((t) => ((chosen.value ?? "") + " " + chosen.text).includes(t.trim().slice(0, 24)));
        if (chosen.role === "AXTextArea" && chosen.state === "filled" && !own && !editAllowed) {
          desc = `blocked: '${chosen.text.slice(0, 30)}' already contains someone else's text (create a new item first)`;
          if (usePlan && safetyReplans < 1) {
            safetyReplans++;
            logStep(desc, [], 0);
            await makePlan(p.screen, p.items, "the text area shows EXISTING content that must not be edited: first create a new item (for example click New Note or New Document), then type").catch(() => {});
            desc = "re-planned: create a new item first";
            holdPlan = true;
          }
          break;
        }
        let text = dec.text;
        const planned = plan?.[planPos];
        if (text === undefined && planned?.action === "type" && planned.text !== undefined) text = planned.text; // from the plan, no extra LLM call
        // the field already holds what this agent wrote (from the writer): writing again would only duplicate it
        const ownField = typedTexts.some((t) => ((chosen.value ?? "") + " " + chosen.text).includes(t.trim().slice(0, 24)));
        if (text === undefined && ownField) {
          desc = `skipped: '${chosen.text.slice(0, 30)}' already holds the text this agent wrote`;
          holdPlan = true;
          break;
        }
        const chosenEl = obs.elements.find((e) => e.token === chosen.token);
        const purpose = firstLabel.get(fieldKey(chosenEl)) || chosen.text; // what the field is for, from its first label
        const messageField = MESSAGE_FIELD.test(purpose) && !FIND_FIELD.test(purpose);
        if (messageField && !SEND_INTENT.test(task.goal)) { desc = `blocked: '${chosen.text}' is a message field and the goal does not ask to send anything`; break; }
        { const whoTo = goalValues(task.goal).targets;
          if (messageField && whoTo.length && !whoTo.some((t) => headed(obs, t))) { desc = `blocked: the conversation on screen is not with ${whoTo.join(" / ")}`; break; } }
        if (text === undefined) {
          const w = await helper.writeText(task.goal, { ...chosen, text: purpose }, p.screen, prev);
          task.counts.helperCalls++;
          task.cost.helperUsd += w.costUsd;
          if (w.llm || llmHelper) noteLlm("write free text");
          log.write({ type: "helper", runId: ctx.runId, t: nowIso(), taskId: task.id, agent, what: "write", detail: `"${w.text.slice(0, 120)}" for '${chosen.text}'`, costUsd: w.costUsd, ms: w.ms });
          text = w.text;
        }
        if (!text) { desc = "blocked: nothing to type"; break; }
        // never type the same text twice: if the field already holds it, that step is done
        if (norm(chosen.value ?? (chosen.role === "AXTextArea" ? chosen.text : "")).includes(norm(text))) {
          desc = `skipped: '${chosen.text.slice(0, 30)}' already contains "${text.slice(0, 40)}"`;
          if (plan) planPos = Math.min(planPos + 1, plan.length);
          holdPlan = true;
          break;
        }
        // single-line fields (search boxes, address bars) are REPLACED, not appended to; text areas are appended to
        if (messageField && text !== undefined && goalValues(task.goal).targets.some((t) => norm(t) === norm(text!))) {
          desc = `blocked: "${text}" is who to reach, not what to say (it does not go into '${chosen.text}')`;
          break;
        }
        if (chosen.state === "filled" && chosen.role !== "AXTextArea") results.push(await driver.setValue(agent, win, chosen.token, ""));
        const typed = text;
        // the same text into the same field once per task: apps that hide a field's contents (WhatsApp) otherwise get
        // it typed again and again
        if (typedInto.get(fieldKey(chosenEl) || chosen.text) === typed) {
          desc = `skipped: "${typed.slice(0, 40)}" was already typed into '${chosen.text}'`;
          if (plan) planPos = Math.min(planPos + 1, plan.length);
          holdPlan = true;
          break;
        }
        // focus the field first: when an app doesn't take text through accessibility, it arrives as key presses, which
        // go to whatever has the keyboard focus (measured: a message landed in the chat list's search box)
        await driver.click(agent, win, chosen.token).catch(() => undefined);
        await sleep(150);
        let r = await retryStale(await driver.typeText(agent, win, chosen.token, typed), (t) => driver.typeText(agent, win, t, typed));
        if (refusedInBackground(r) && allowForeground) {
          results.push(r);
          r = await driver.typeText(agent, win, chosen.token, text, true);
          task.counts.foreground++;
        }
        results.push(r);
        // where did it land? if ANOTHER field now holds it, it went to the wrong place: clear that, and don't count it
        // (only when the field has a position to tell it apart by: otherwise it could be mistaken for "another" field)
        if (r.ok && fieldKey(chosenEl)) {
          const after = await driver.observe(agent, win);
          const head = norm(text).slice(0, 16);
          learnFields(after);
          const elsewhere = after.elements.find((e) => e.token && TEXT_INPUT.has(e.role) && fieldKey(e) !== fieldKey(chosenEl) && norm(`${e.value ?? ""} ${e.label ?? ""}`).includes(head));
          if (elsewhere?.token) {
            await driver.setValue(agent, win, elsewhere.token, "").catch(() => undefined);
            const clear = after.elements.find((e) => e.role === "AXButton" && /^clear( text)?$/i.test((e.label ?? "").trim()) && e.token);
            if (clear?.token && norm(elsewhere.value ?? "") ) await driver.click(agent, win, clear.token).catch(() => undefined);
            desc = `typing landed in '${elsewhere.label ?? "another field"}' instead of '${chosen.text}': cleared it`;
            break;
          }
          // and did it land in the field itself? (when the app shows the field's contents) If not, paste it once
          const mine = after.elements.find((e) => fieldKey(e) === fieldKey(chosenEl) && e.token);
          if (mine?.token && mine.value !== undefined && !norm(mine.value).includes(head)) {
            const pr = driver.paste ? await driver.paste(agent, win, mine.token, typed) : undefined;
            if (pr) results.push(pr);
            const again = (await driver.observe(agent, win)).elements.find((e) => fieldKey(e) === fieldKey(chosenEl));
            if (!again || again.value === undefined || !norm(again.value).includes(head)) {
              desc = `typing did not land in '${chosen.text}' (it still holds "${norm(again?.value ?? "").slice(0, 30)}")`;
              break;
            }
          }
        }
        if (r.ok) {
          typedTexts.push(text);
          typedInto.set(fieldKey(chosenEl) || chosen.text, typed);
          lastTyped = { id: chosen.id, label: chosen.text, text, foreground: r.channel === "foreground" };
        }
        desc = `type "${text.length > 60 ? text.slice(0, 57) + "..." : text}" into '${chosen.text}'${r.channel === "foreground" ? " (foreground)" : ""}`;
        break;
      }
      case "press_enter":
      case "press_escape": {
        const k = dec.kind === "press_enter" ? "return" : "escape";
        // read-back before sending: the field must hold exactly what was typed (a lost first keystroke must not be sent)
        if (k === "return" && lastTyped) {
          const f = p.items.find((i) => isTextInput(i) && (i.id === lastTyped!.id || i.text === lastTyped!.label));
          if (f?.token && f.value !== undefined && !norm(f.value).includes(norm(lastTyped.text))) {
            if (retyped) {
              desc = `blocked: the field still does not contain the typed text ("${norm(f.value).slice(0, 40)}"), not sending`;
              logStep(desc, [], 0);
              return finish("driver_refused", `typing did not land correctly in '${f.text}', so it was not sent`);
            }
            retyped = true;
            results.push(await driver.setValue(agent, win, f.token, ""));
            results.push(await driver.typeText(agent, win, f.token, lastTyped.text, lastTyped.foreground));
            if (lastTyped.foreground) task.counts.foreground++;
            holdPlan = true; // Enter is still to come
            desc = `re-typed into '${f.text}': it held "${norm(f.value).slice(0, 30)}" instead of the full text`;
            break;
          }
        }
        // SAFETY: Enter in a message field sends it: only when the goal asks to send something, and only to the one the
        // goal names (the open content's title must be them: measured, a message aimed at "You" sat in another chat)
        const enterIn = isTextInput(chosen) ? chosen : p.items.find((i) => isTextInput(i) && i.state === "filled");
        const whoTo = goalValues(task.goal).targets;
        if (k === "return" && enterIn && MESSAGE_FIELD.test(firstLabel.get(fieldKey(obs.elements.find((e) => e.token === enterIn.token))) || enterIn.text) && whoTo.length && !whoTo.some((t) => headed(obs, t))) {
          desc = `blocked: the conversation on screen is not with ${whoTo.join(" / ")}, not sending`;
          notReached.add(compact(whoTo[0]!));
          break;
        }
        if (k === "return" && enterIn && MESSAGE_FIELD.test(enterIn.text) && !FIND_FIELD.test(enterIn.text) && !SEND_INTENT.test(task.goal)) {
          desc = `blocked: Enter in '${enterIn.text}' would send it, and the goal does not ask to send anything`;
          break;
        }
        // Enter on a field that supports AXConfirm needs no keyboard at all (keys are refused when an app has 2 windows)
        const field = isTextInput(chosen) ? chosen : p.items.find((i) => isTextInput(i) && i.state === "filled" && i.actions?.includes("AXConfirm"));
        if (k === "return" && field?.token && field.actions?.includes("AXConfirm")) {
          results = [await driver.confirm(agent, win, field.token)];
          desc = `confirm '${field.text}' (Enter via accessibility)`;
        } else {
          let r = await driver.pressKey(agent, win, k, isTextInput(chosen) ? chosen!.token : undefined);
          results = [r];
          if (refusedInBackground(r) && allowForeground) {
            r = await driver.pressKey(agent, win, k, isTextInput(chosen) ? chosen!.token : undefined, true);
            results.push(r);
            task.counts.foreground++;
          }
          desc = `press ${k}${isTextInput(chosen) ? ` in '${chosen!.text}'` : ""}${r.channel === "foreground" ? " (foreground)" : ""}`;
        }
        break;
      }
      case "scroll_down":
      case "scroll_up": {
        results = [await driver.scroll(agent, win, dec.kind === "scroll_down" ? "down" : "up", chosen?.token)];
        desc = dec.kind.replace("_", " ");
        break;
      }
      case "wait": {
        await sleep(600);
        desc = "wait";
        break;
      }
    }
    const actMs = performance.now() - t1;
    task.counts.actions += results.length;
    logStep(desc, results, actMs);
    prev.push(desc);
    if (desc.startsWith("blocked")) {
      repeats++;
      if (repeats >= 2 && !(await escalate(p, desc))) return finish("stalled", desc);
      continue;
    }
    const last = results[results.length - 1];
    if (plan && last?.ok && !holdPlan) planPos = Math.min(planPos + 1, plan.length);
    const bad = last && !last.ok ? last : undefined;
    if (bad) {
      const fatal = bad.error?.code === "permissions_pending" || (bad.error?.code === "minimized_or_hidden" && !allowForeground);
      if (fatal) return finish("driver_refused", `${bad.error?.code}: ${bad.error?.detail ?? ""}`);
      // e.g. AXPress unsupported on a text area, or keys refused because the app has two windows: note it, try another way
      prev.push(`(${desc} FAILED: ${bad.error?.code}${bad.error?.code === "keyboard_ambiguity" ? ": the app has more than one window, keys are refused" : ""})`);
      if (plan && dec.kind === "click" && isTextInput(chosen)) planPos = Math.min(planPos + 1, plan.length); // clicking a field first is unnecessary
      repeats++;
      if (repeats >= 3) return finish("driver_refused", `actions keep failing: ${bad.error?.code}: ${bad.error?.detail ?? ""}`);
      continue;
    }
  }
  return finish("step_limit", `more than ${max} steps`);
}
