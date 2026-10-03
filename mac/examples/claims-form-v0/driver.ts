// CliDriver: every action is one `cua-driver call <tool> '<json>'` subprocess.
// Why a subprocess per call: 0.02 s overhead, every call is its own daemon connection (so observations are parallel),
// it survives daemon restarts, and every logged call can be pasted into a terminal and replayed.
import type {
  AxElement,
  ActionResult,
  Channel,
  Driver,
  DriverErrorCode,
  AgentName,
  Observation,
  WindowRaw,
  WindowRef,
} from "./contracts.ts";

const BIN =
  Bun.which("cua-driver") ??
  `${process.env.HOME}/.local/bin/cua-driver`;

export interface RawCall {
  json: any;
  raw: string;
  exit: number;
  ms: number;
  cli: string;
}

export async function cua(tool: string, args: object, timeoutMs = 12000): Promise<RawCall> {
  const body = JSON.stringify(args);
  const cli = `cua-driver call ${tool} '${body}'`;
  const t0 = performance.now();
  const proc = Bun.spawn([BIN, "call", tool, body], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(killer);
  const ms = performance.now() - t0;
  const raw = (out + err).trim();
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { json, raw, exit, ms, cli };
}

export function classifyError(rc: RawCall): { code: DriverErrorCode; detail: string } | undefined {
  const text = rc.raw;
  if (rc.json === undefined) {
    if (/permissions_pending/.test(text)) return { code: "permissions_pending", detail: text.slice(0, 200) };
    if (/session has ended/.test(text)) return { code: "session_ended", detail: text.slice(0, 200) };
    if (rc.exit !== 0 || text) return { code: rc.ms >= 11900 ? "timeout" : "other", detail: text.slice(0, 200) };
    return { code: "other", detail: "empty output" };
  }
  const j = rc.json;
  if (j.effect === "refused" || j.status === "refused") {
    const reason: string = j.escalation?.reason ?? j.refusal?.message ?? "refused";
    let code: DriverErrorCode = "refused";
    if (/same_pid_keyboard|other eligible top-level/.test(reason)) code = "keyboard_ambiguity";
    else if (/minimi|hidden/.test(reason)) code = "minimized_or_hidden";
    else if (/could not be proven|stale/.test(reason)) code = "stale_element_token";
    return { code, detail: reason.slice(0, 240) };
  }
  if (j.error) return { code: "other", detail: JSON.stringify(j.error).slice(0, 240) };
  return undefined;
}

function toResult(rc: RawCall, channel: Channel): ActionResult {
  const err = classifyError(rc);
  const route: string | undefined = rc.json?.route;
  const ch: Channel = channel === "ax" && route === "synthetic_events" ? "synthetic" : channel;
  return {
    ok: !err,
    effect: rc.json?.effect,
    route,
    channel: ch,
    error: err,
    ms: Math.round(rc.ms),
    cli: rc.cli,
  };
}

export class CliDriver implements Driver {
  private sessions = new Set<string>();
  /** rolling action latencies (ms) for the "daemon untuned" warning */
  readonly clickMs: number[] = [];

  /** a session that ended (5 min idle, or end_session) refuses calls until start_session: revive it and retry once */
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
    await cua("set_agent_cursor_motion", { session: agent, glide_duration_ms: 150, dwell_after_click_ms: 0 });
    this.sessions.add(agent);
  }

  async listWindows(): Promise<{ windows: WindowRaw[] }> {
    const rc = await cua("list_windows", {});
    if (!rc.json) throw new Error(`list_windows failed: ${rc.raw.slice(0, 200)}`);
    return rc.json;
  }

  async launchApp(agent: AgentName, bundleId: string, urls: string[]): Promise<{ pid: number }> {
    const rc = await cua("launch_app", { bundle_id: bundleId, urls, session: agent }, 30000);
    if (!rc.json?.pid) throw new Error(`launch_app failed: ${rc.raw.slice(0, 200)}`);
    return { pid: rc.json.pid };
  }

  async observe(agent: AgentName, w: WindowRef, opts?: { timeoutMs?: number }): Promise<Observation> {
    const rc = await this.call(agent, "get_window_state", {
      pid: w.pid,
      window_id: w.windowId,
      session: agent,
      include_screenshot: false,
      timeout_ms: opts?.timeoutMs ?? 3000,
    });
    const j = rc.json;
    if (!j) {
      return { agent, window: w, elements: [], truncated: false, degraded: classifyError(rc)?.code ?? "other", ms: Math.round(rc.ms) };
    }
    const elements: AxElement[] = (j.elements ?? []).map((e: any) => ({
      index: e.element_index,
      parent: e.parent_index ?? undefined,
      depth: e.depth ?? 0,
      token: e.element_token,
      role: e.role,
      label: e.label ?? undefined,
      value: e.value == null ? undefined : String(e.value),
      frame: e.frame ? { x: e.frame.x, y: e.frame.y, w: e.frame.w, h: e.frame.h } : undefined,
      actions: e.actions ?? [],
    }));
    return {
      agent,
      window: w,
      elements,
      truncated: !!j.truncated,
      degraded: j.degraded_reason ? String(j.degraded_reason).split(":")[0] : undefined,
      ms: Math.round(rc.ms),
    };
  }

  async click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult> {
    const rc = await this.call(agent, "click", { pid: w.pid, window_id: w.windowId, element_token: token, session: agent });
    this.clickMs.push(rc.ms);
    if (this.clickMs.length > 20) this.clickMs.shift();
    return toResult(rc, "ax");
  }

  async typeText(agent: AgentName, w: WindowRef, token: string, text: string): Promise<ActionResult> {
    const rc = await this.call(agent, "type_text", { pid: w.pid, window_id: w.windowId, element_token: token, text, session: agent });
    return toResult(rc, "ax");
  }

  async pressKey(agent: AgentName, w: WindowRef, key: "escape" | "tab" | "return"): Promise<ActionResult> {
    const rc = await this.call(agent, "press_key", { pid: w.pid, window_id: w.windowId, key, session: agent });
    return toResult(rc, "ax");
  }

  async endAll(): Promise<void> {
    for (const s of this.sessions) await cua("end_session", { session: s });
    this.sessions.clear();
  }

  /** median of the last clicks; > ~1300 ms means the daemon is untuned */
  medianClickMs(): number | undefined {
    if (this.clickMs.length < 3) return undefined;
    const s = [...this.clickMs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
