// CliDriver: every action is one `cua-driver call <tool> '<json>'` subprocess.
// Why a subprocess per call: ~0.02 s overhead, every call is its own daemon connection (so two agents observe in
// parallel), it survives daemon restarts, and every logged call can be pasted into a terminal and replayed.
import type {
  ActionResult, AppInfo, AxElement, Channel, Driver, DriverErrorCode, AgentName, Observation, Rect, WindowRaw, WindowRef,
} from "./contracts.ts";

import { FastLane } from "./fastlane.ts";

const BIN = Bun.which("cua-driver") ?? `${process.env.HOME}/.local/bin/cua-driver`;

export interface RawCall { json: any; raw: string; exit: number; ms: number; cli: string }

export async function cua(tool: string, args: object, timeoutMs = 15000): Promise<RawCall> {
  const body = JSON.stringify(args);
  const cli = `cua-driver call ${tool} '${body}'`;
  const t0 = performance.now();
  const proc = Bun.spawn([BIN, "call", tool, body], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(killer);
  const ms = performance.now() - t0;
  let json: any;
  try { json = JSON.parse(out); } catch { json = undefined; }
  return { json, raw: (out + err).trim(), exit, ms, cli };
}

export function classifyError(rc: RawCall): { code: DriverErrorCode; detail: string } | undefined {
  const text = rc.raw;
  if (rc.json === undefined) {
    if (/permissions_pending/.test(text)) return { code: "permissions_pending", detail: text.slice(0, 200) };
    if (/session has ended/.test(text)) return { code: "session_ended", detail: text.slice(0, 200) };
    return { code: rc.ms >= 14900 ? "timeout" : "other", detail: text.slice(0, 200) || "empty output" };
  }
  const j = rc.json;
  if (j.effect === "refused" || j.status === "refused") {
    const reason: string = j.escalation?.reason ?? j.refusal?.message ?? "refused";
    let code: DriverErrorCode = "refused";
    if (/same_pid_keyboard|other eligible top-level/.test(reason)) code = "keyboard_ambiguity";
    else if (/background text route|background_unavailable|cannot establish a safe/i.test(reason)) code = "background_unavailable";
    else if (/minimi|hidden/.test(reason)) code = "minimized_or_hidden";
    else if (/could not be proven|stale/.test(reason)) code = "stale_element_token";
    return { code, detail: reason.slice(0, 240) };
  }
  if (j.error) return { code: "other", detail: JSON.stringify(j.error).slice(0, 240) };
  return undefined;
}

function toResult(rc: RawCall): ActionResult {
  let err = classifyError(rc);
  // AXError -25205 (kAXErrorCannotComplete) is often returned although the press DID happen (seen live on Notes'
  // "New Note" and Reminders' "Add Reminder"): treat it as unverified; the next observation shows what really happened
  if (err && /-25205/.test(err.detail)) err = undefined;
  const route: string | undefined = rc.json?.route;
  const channel: Channel = route === "synthetic_events" ? "synthetic" : route === "global_input" ? "foreground" : "ax";
  return { ok: !err, effect: rc.json?.effect, route, channel, error: err, ms: Math.round(rc.ms), cli: rc.cli };
}

/** an action done on screen, for the overlay (a flash in the agent's colour where it pressed or typed) */
export interface ActionNote { agent: AgentName; frame: Rect; kind: "press" | "type"; via: "fast" | "cua" }

/** app and window names can carry invisible direction marks ("\u200eWhatsApp"): the name the user types has none */
const clean = (s: string) => String(s ?? "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();

export class CliDriver implements Driver {
  private sessions = new Set<string>();
  readonly clickMs: number[] = [];
  /** clicks and native text inserts straight through accessibility; Cua for everything else and as the fallback */
  readonly fast = new FastLane();
  readonly counts = { fast: 0, cua: 0, fellBack: 0 };
  /** what each element token pointed at when it was read: lets the fast lane find the same element */
  private seen = new Map<string, { pid: number; role: string; label?: string; frame?: Rect }>();
  onAction?: (n: ActionNote) => void;
  /** Cua's own gliding cursors; off when the overlay draws the agents' cursors (one cursor per agent, not two) */
  cuaCursors = true;

  /** a session that ended (5 min idle, or end_session) refuses calls until start_session: revive it, retry once */
  private async call(agent: AgentName, tool: string, args: object, timeoutMs?: number): Promise<RawCall> {
    let rc = await cua(tool, args, timeoutMs);
    if (classifyError(rc)?.code === "session_ended") {
      await this.ensureSession(agent);
      rc = await cua(tool, args, timeoutMs);
    }
    return rc;
  }

  async ensureSession(agent: AgentName): Promise<void> {
    await cua("start_session", { session: agent });
    // the cursor glide, not the input lock, dominated click time: 150 ms glide + no dwell = ~0.6 s per click (measured)
    await cua("set_agent_cursor_motion", { session: agent, glide_duration_ms: 150, dwell_after_click_ms: 0 });
    if (!this.cuaCursors) await cua("set_agent_cursor_enabled", { session: agent, enabled: false });
    this.sessions.add(agent);
  }

  async listWindows(): Promise<{ windows: WindowRaw[] }> {
    // normally ~60 ms; the CLI occasionally hangs, so a short timeout and one retry instead of waiting 15 s
    let rc = await cua("list_windows", {}, 4000);
    if (!rc.json) rc = await cua("list_windows", {}, 8000);
    if (!rc.json) throw new Error(`list_windows failed: ${rc.raw.slice(0, 200)}`);
    for (const w of rc.json.windows ?? []) { w.app_name = clean(w.app_name); w.title = clean(w.title ?? ""); }
    return rc.json;
  }

  async listApps(): Promise<AppInfo[]> {
    const rc = await cua("list_apps", {});
    const arr = Array.isArray(rc.json) ? rc.json : rc.json?.apps;
    if (!Array.isArray(arr)) throw new Error(`list_apps failed: ${rc.raw.slice(0, 200)}`);
    return arr.map((a: any) => ({ name: clean(a.name), bundle_id: a.bundle_id, running: !!a.running, pid: a.pid }));
  }

  async launchApp(agent: AgentName, bundleId: string, urls: string[] = [], opts: { newInstance?: boolean; args?: string[] } = {}): Promise<{ pid: number }> {
    const args: any = { bundle_id: bundleId, session: agent };
    if (urls.length) args.urls = urls;
    if (opts.newInstance) args.creates_new_application_instance = true;
    if (opts.args?.length) args.additional_arguments = opts.args;
    const rc = await cua("launch_app", args, 30000);
    if (!rc.json?.pid) throw new Error(`launch_app failed: ${rc.raw.slice(0, 200)}`);
    return { pid: rc.json.pid };
  }

  async observe(agent: AgentName, w: WindowRef, opts?: { timeoutMs?: number; maxDepth?: number }): Promise<Observation> {
    const args: any = { pid: w.pid, window_id: w.windowId, session: agent, include_screenshot: false, timeout_ms: opts?.timeoutMs ?? 3000 };
    if (opts?.maxDepth) args.max_depth = opts.maxDepth;
    const rc = await this.call(agent, "get_window_state", args, (opts?.timeoutMs ?? 3000) + 15000);
    const j = rc.json;
    if (!j) return { agent, window: w, elements: [], truncated: false, degraded: classifyError(rc)?.code ?? "other", ms: Math.round(rc.ms) };
    const elements: AxElement[] = (j.elements ?? []).map((e: any) => ({
      index: e.element_index, parent: e.parent_index ?? undefined, depth: e.depth ?? 0, token: e.element_token,
      role: e.role, label: e.label ?? undefined, value: e.value == null ? undefined : String(e.value),
      frame: e.frame ? { x: e.frame.x, y: e.frame.y, w: e.frame.w, h: e.frame.h } : undefined, actions: e.actions ?? [],
    }));
    for (const e of elements) if (e.token) this.seen.set(e.token, { pid: w.pid, role: e.role, label: e.label, frame: e.frame });
    if (this.seen.size > 20000) this.seen = new Map([...this.seen].slice(-5000));
    return {
      agent, window: w, elements, truncated: !!j.truncated,
      degraded: j.degraded_reason ? String(j.degraded_reason).split(":")[0] : undefined, ms: Math.round(rc.ms),
      markdown: typeof j.tree_markdown === "string" ? j.tree_markdown : undefined,
    };
  }

  /** try the fast lane; undefined = do it through Cua (the fast lane is off, or couldn't do it safely) */
  private async tryFast(agent: AgentName, token: string, kind: "press" | "type", text?: string): Promise<ActionResult | undefined> {
    const el = this.seen.get(token);
    if (!this.fast.on || !el?.frame) return undefined;
    const t = { pid: el.pid, frame: el.frame, role: el.role, label: el.label };
    const r = kind === "press" ? await this.fast.press(t) : await this.fast.type(t, text ?? "");
    const cli = `fastlane ${kind} ${el.role} "${el.label ?? ""}"${kind === "type" ? ` "${(text ?? "").slice(0, 40)}"` : ""}`;
    if (!r.ok) {
      this.counts.fellBack++;
      console.log(`[fast lane] ${cli} → Cua (${r.error})`);
      return undefined;
    }
    this.counts.fast++;
    this.onAction?.({ agent, frame: el.frame, kind, via: "fast" });
    return { ok: true, route: "fast_lane", channel: "ax", ms: Math.round(r.ms), cli };
  }

  private noteCua(agent: AgentName, token: string, kind: "press" | "type") {
    this.counts.cua++;
    const f = this.seen.get(token)?.frame;
    if (f) this.onAction?.({ agent, frame: f, kind, via: "cua" });
  }

  async click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult> {
    const fast = await this.tryFast(agent, token, "press");
    const result = fast ?? toResult(await this.call(agent, "click", { pid: w.pid, window_id: w.windowId, element_token: token, session: agent }));
    if (!fast) this.noteCua(agent, token, "press");
    this.clickMs.push(result.ms);
    if (this.clickMs.length > 20) this.clickMs.shift();
    return result;
  }

  async typeText(agent: AgentName, w: WindowRef, token: string, text: string, foreground = false): Promise<ActionResult> {
    if (!foreground) {
      const fast = await this.tryFast(agent, token, "type", text);
      if (fast) return fast;
    }
    this.noteCua(agent, token, "type");
    // long or multi-line text is PASTED: typed as key presses it took 55 s for an itinerary, and in apps where Enter
    // sends (chats) each line break sent a fragment of it
    if (!foreground && (text.includes("\n") || text.length > 60)) {
      const r = await this.paste(agent, w, token, text);
      if (r.ok) return r;
    }
    const args: any = { pid: w.pid, window_id: w.windowId, element_token: token, text, session: agent };
    if (foreground) args.delivery_mode = "foreground";
    const r = toResult(await this.call(agent, "type_text", args, 30000));
    if (foreground) r.channel = "foreground";
    return r;
  }

  /** put the text on the clipboard (checked), Cmd+V into the field, then put the user's clipboard back */
  async paste(agent: AgentName, w: WindowRef, token: string, text: string): Promise<ActionResult> {
    const t0 = performance.now();
    const before = await cua("clipboard_read", { include_text: true, session: agent });
    const saved: string | null = typeof before.json?.text === "string" ? before.json.text : null;
    const fail = (why: string): ActionResult => ({ ok: false, channel: "synthetic", ms: Math.round(performance.now() - t0), cli: "paste", error: { code: "other", detail: why } });
    const wr = await cua("clipboard_write", { text, session: agent });
    if (!wr.json || wr.json.error) return fail(`clipboard_write: ${wr.raw.slice(0, 120)}`);
    const check = await cua("clipboard_read", { include_text: true, session: agent });
    if (check.json?.text !== text) return fail("the clipboard does not hold the text");
    const rc = await this.call(agent, "hotkey", { pid: w.pid, window_id: w.windowId, element_token: token, keys: ["cmd", "v"], session: agent });
    if (saved !== null) await cua("clipboard_write", { text: saved, session: agent }); // the user's clipboard, back
    const r = toResult(rc);
    return { ...r, route: "paste", ms: Math.round(performance.now() - t0), cli: `paste ${text.length} chars (clipboard, Cmd+V)` };
  }

  async pressKey(agent: AgentName, w: WindowRef, key: "escape" | "tab" | "return", token?: string, foreground = false): Promise<ActionResult> {
    const args: any = { pid: w.pid, window_id: w.windowId, key, session: agent };
    if (token) args.element_token = token;
    const f = token ? this.seen.get(token)?.frame : undefined;
    if (f) this.onAction?.({ agent, frame: f, kind: "press", via: "cua" });
    if (foreground) args.delivery_mode = "foreground";
    const r = toResult(await this.call(agent, "press_key", args));
    if (foreground) r.channel = "foreground";
    return r;
  }

  async scroll(agent: AgentName, w: WindowRef, direction: "up" | "down", token?: string): Promise<ActionResult> {
    const args: any = { pid: w.pid, window_id: w.windowId, direction, by: "page", amount: 1, session: agent };
    if (token) args.element_token = token;
    return toResult(await this.call(agent, "scroll", args));
  }

  async confirm(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult> {
    return toResult(await this.call(agent, "click", { pid: w.pid, window_id: w.windowId, element_token: token, action: "confirm", session: agent }));
  }

  async setValue(agent: AgentName, w: WindowRef, token: string, value: string): Promise<ActionResult> {
    return toResult(await this.call(agent, "set_value", { pid: w.pid, window_id: w.windowId, element_token: token, value, session: agent }));
  }

  async endSession(agent: AgentName): Promise<void> {
    await cua("end_session", { session: agent });
    this.sessions.delete(agent);
  }

  medianClickMs(): number | undefined {
    if (this.clickMs.length < 3) return undefined;
    const s = [...this.clickMs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
