// A simulated Calculator window + driver, for offline tests of the engine.
import type { ActionResult, AppInfo, AxElement, Driver, AgentName, Observation, WindowRef } from "../src/contracts.ts";

const BUTTONS = ["All Clear", "7", "8", "9", "Multiply", "4", "5", "6", "Subtract", "1", "2", "3", "Add", "0", "Equals"];

export class SimCalc implements Driver {
  display = "0";
  acc: number | null = null;
  op: string | null = null;
  fresh = true;
  snap = 0;
  tokens = new Map<string, string>();
  calls: string[] = [];
  failClicks = false;
  readonly win: WindowRef = { pid: 77, windowId: 5, app: "Calculator", title: "Calculator" };

  private ok(): ActionResult { return { ok: true, effect: "unverifiable", route: "accessibility", channel: "ax", ms: 1, cli: "sim" }; }
  async ensureSession() {}
  async endSession() {}
  async listApps(): Promise<AppInfo[]> { return [{ name: "Calculator", bundle_id: "com.apple.calculator", running: true }]; }
  async listWindows() {
    return { windows: [{ app_name: "Calculator", title: "Calculator", pid: 77, window_id: 5, bounds: { x: 0, y: 0, width: 230, height: 408 } }] };
  }
  async launchApp() { return { pid: 77 }; }

  async observe(agent: AgentName, w: WindowRef): Promise<Observation> {
    this.snap++;
    this.tokens.clear();
    const els: AxElement[] = [
      { index: 0, depth: 0, role: "AXMenuBar", label: "menu", actions: [] },
      { index: 1, parent: 0, depth: 1, role: "AXButton", label: "Quit", token: `s${this.snap}:q`, actions: ["AXPress"] }, // must be ignored
      { index: 2, depth: 0, role: "AXWindow", label: "Calculator", actions: [] },
    ];
    BUTTONS.forEach((b, k) => {
      const token = `s${this.snap}:${k}`;
      this.tokens.set(token, b);
      els.push({ index: 3 + k, parent: 2, depth: 1, role: "AXButton", label: b, token, actions: ["AXPress"] });
    });
    const markdown = `- [0] AXMenuBar\n  - AXStaticText = "menu text"\n- [2] AXWindow "Calculator"\n    - AXStaticText = "‎${this.display}"\n`;
    return { agent, window: w, elements: els, truncated: false, ms: 1, markdown };
  }

  async click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult> {
    const b = this.tokens.get(token);
    if (!b) return { ...this.ok(), ok: false, error: { code: "stale_element_token", detail: "stale" } };
    if (this.failClicks) return { ...this.ok(), ok: false, error: { code: "other", detail: "AXPress returned -25206" } };
    this.calls.push(b);
    if (/^\d$/.test(b)) {
      this.display = this.fresh || this.display === "0" ? b : this.display + b;
      this.fresh = false;
    } else if (b === "All Clear") {
      this.display = "0"; this.acc = null; this.op = null; this.fresh = true;
    } else if (b === "Equals" && this.acc !== null && this.op) {
      const x = Number(this.display);
      const r = this.op === "Multiply" ? this.acc * x : this.op === "Add" ? this.acc + x : this.acc - x;
      this.display = String(r); this.acc = null; this.op = null; this.fresh = true;
    } else {
      this.acc = Number(this.display); this.op = b; this.fresh = true;
    }
    return this.ok();
  }
  async typeText(): Promise<ActionResult> { return { ...this.ok(), ok: false, error: { code: "other", detail: "no text fields" } }; }
  async pressKey(): Promise<ActionResult> { return this.ok(); }
  async scroll(): Promise<ActionResult> { return this.ok(); }
  async confirm(): Promise<ActionResult> { return this.ok(); }
  async setValue(): Promise<ActionResult> { return this.ok(); }
}
