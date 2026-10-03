// A simulated Safari + driver for offline tests. It mimics the behaviours we measured live, including the nasty ones:
//  - type_text INSERTS at the caret (it appends), it never replaces
//  - element tokens die as soon as a newer snapshot is taken
//  - a drop-down is filled by click -> Escape -> type-ahead
// Faults can be injected to prove the guards work.
import type { ActionResult, AxElement, Driver, AgentName, Observation, WindowRaw, WindowRef } from "../src/contracts.ts";

export interface SimFaults {
  prefill?: Partial<Record<"payee" | "amount" | "date", string>>; // a dirty form at the start
  dropTypingFor?: "payee" | "amount" | "date"; // typing into this field is silently ignored
  corruptTypingFor?: "payee" | "amount" | "date"; // typing into this field appends an extra character
  noReset?: boolean; // the form keeps its values after submit
  serverBase: string; // the real replica server
}

const LABELS = { payee: "Payee name", amount: "Amount (HKD)", date: "Date of expense (DD/MM/YYYY)" } as const;
const OPTIONS = ["Food", "Transport", "Printing", "Venue"];

export class SimDriver implements Driver {
  vals = { payee: "", amount: "", date: "", category: "", paidby: "" };
  menuOpen = false;
  snap = 0;
  tokens = new Map<string, string>(); // token -> control name
  calls: string[] = [];
  readonly win: WindowRaw = { app_name: "Safari", title: "Society claims form (replica)", pid: 4242, window_id: 7, bounds: { x: 0, y: 0, width: 1000, height: 800 }, is_on_screen: true, on_current_space: true };

  constructor(public faults: SimFaults) {
    Object.assign(this.vals, faults.prefill ?? {});
  }

  private res(ok = true, error?: ActionResult["error"]): ActionResult {
    return { ok, effect: "unverifiable", route: "synthetic_events", channel: "synthetic", ms: 1, cli: "sim", error };
  }

  async ensureSession(): Promise<void> {}
  async listWindows() { return { windows: [this.win] }; }
  async launchApp() { return { pid: this.win.pid }; }
  async endAll() {}

  async observe(agent: AgentName, w: WindowRef): Promise<Observation> {
    this.snap++;
    this.tokens.clear();
    const els: AxElement[] = [];
    let idx = 0;
    const add = (role: string, label: string | undefined, value: string | undefined, name?: string, parent?: number): number => {
      const e: AxElement = { index: idx++, parent, depth: parent === undefined ? 0 : 1, role, label, value, actions: [] };
      if (name) {
        e.token = `s${this.snap}:${e.index}`;
        this.tokens.set(e.token, name);
      }
      els.push(e);
      return e.index;
    };
    add("AXTextField", "smart search field", "127.0.0.1:8765", "chrome-address"); // browser chrome, must be ignored
    const root = add("AXWebArea", this.win.title, undefined, "web");
    for (const k of ["payee", "amount", "date"] as const) {
      add("AXStaticText", LABELS[k], LABELS[k], undefined, root); // the visible label text
      add("AXTextField", LABELS[k], this.vals[k] || undefined, k, root);
    }
    add("AXPopUpButton", "Category", this.vals.category || "Choose…", "category", root);
    add("AXRadioButton", "Cash", this.vals.paidby === "Cash" ? "1" : "0", "radio:Cash", root);
    add("AXRadioButton", "FPS", this.vals.paidby === "FPS" ? "1" : "0", "radio:FPS", root);
    add("AXButton", "Submit claim", undefined, "submit", root);
    add("AXButton", "Clear form", undefined, "clear", root);
    return { agent, window: w, elements: els, truncated: false, ms: 1 };
  }

  private resolve(token: string): string | ActionResult {
    const name = this.tokens.get(token);
    if (!name) return this.res(false, { code: "stale_element_token", detail: "token from an older snapshot" });
    return name;
  }

  async click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult> {
    const name = this.resolve(token);
    if (typeof name !== "string") return name;
    this.calls.push(`click ${name}`);
    if (name === "category") this.menuOpen = true;
    else if (name.startsWith("radio:")) this.vals.paidby = name.slice(6);
    else if (name === "clear") this.reset();
    else if (name === "submit") {
      const body = new URLSearchParams({ payee: this.vals.payee, amount: this.vals.amount, date: this.vals.date, category: this.vals.category, paidby: this.vals.paidby });
      await fetch(`${this.faults.serverBase}/submit`, { method: "POST", body, redirect: "manual" });
      if (!this.faults.noReset) this.reset();
    }
    return this.res();
  }

  private reset() {
    this.vals = { payee: "", amount: "", date: "", category: "", paidby: "" };
    this.menuOpen = false;
  }

  async typeText(agent: AgentName, w: WindowRef, token: string, text: string): Promise<ActionResult> {
    const name = this.resolve(token);
    if (typeof name !== "string") return name;
    this.calls.push(`type ${name} "${text}"`);
    if (name === "payee" || name === "amount" || name === "date") {
      if (this.faults.dropTypingFor === name) return this.res();
      const extra = this.faults.corruptTypingFor === name ? "X" : "";
      this.vals[name] += text + extra; // appends, exactly like the real thing
    } else if (name === "category") {
      const hit = OPTIONS.find((o) => o.toLowerCase().startsWith(text.toLowerCase()));
      if (hit) this.vals.category = hit;
    }
    return this.res();
  }

  async pressKey(agent: AgentName, w: WindowRef, key: "escape" | "tab" | "return"): Promise<ActionResult> {
    this.calls.push(`key ${key}`);
    if (key === "escape") this.menuOpen = false;
    return this.res();
  }
}
