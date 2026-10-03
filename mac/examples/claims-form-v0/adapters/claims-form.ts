// The claims-form adapter: knows the form's fields, how to fill each control type in a BACKGROUND Safari window,
// how to read every field back, and how to ask the form's own database (the oracle) whether a claim really landed.
//
// Recipes come from live tests on the booth Mac (agents-research/research-live-gates.md, section G-S):
//  - text fields:  type_text with the element token (INSERTS at the caret, never replaces: the field must be empty first)
//  - drop-down:    set_value hangs and menu items can't be clicked; click (opens menu) -> Escape -> type-ahead prefix works
//  - radio/submit: plain AX click
import type {
  ActionResult,
  Claim,
  Driver,
  FillState,
  AgentName,
  Item,
  Observation,
  OracleResult,
  WindowRef,
} from "../contracts.ts";
import { perceive } from "../perceive.ts";

export interface FieldSpec {
  key: keyof Claim;
  label: string; // the aria-label Safari exposes
  control: "text" | "select" | "radio";
  options?: string[];
}

export const FIELDS: FieldSpec[] = [
  { key: "payee", label: "Payee name", control: "text" },
  { key: "amount", label: "Amount (HKD)", control: "text" },
  { key: "date", label: "Date of expense (DD/MM/YYYY)", control: "text" },
  { key: "category", label: "Category", control: "select", options: ["Food", "Transport", "Printing", "Venue"] },
  { key: "paidBy", label: "Paid by", control: "radio", options: ["Cash", "FPS"] },
];

export const SUBMIT_LABEL = "Submit claim";
export const CLEAR_LABEL = "Clear form";
export const CATEGORIES = FIELDS.find((f) => f.key === "category")!.options!;
export const PAYERS = FIELDS.find((f) => f.key === "paidBy")!.options!;

export function goalFor(c: Claim): string {
  return `Enter this claim into the society claims form and submit it: ${c.payee}, HK$${c.amount}, ${c.date}, ${c.category}, paid by ${c.paidBy}.`;
}

/** which claim key a control on the page belongs to (null for buttons and unknown controls) */
export function fieldForItem(it: Item): FieldSpec | null {
  if (it.role === "AXRadioButton") return FIELDS.find((f) => f.control === "radio" && f.options!.includes(it.text)) ?? null;
  return FIELDS.find((f) => f.label === it.text && f.control !== "radio") ?? null;
}

/** shortest prefix that picks exactly this option when typed into a drop-down (type-ahead) */
export function uniquePrefix(option: string, all: string[]): string {
  const o = option.toLowerCase();
  for (let n = 1; n <= option.length; n++) {
    const p = o.slice(0, n);
    if (all.filter((x) => x.toLowerCase().startsWith(p)).length === 1) return option.slice(0, n);
  }
  return option;
}

/** read every claim field back from the page and compare it with what we intend to enter */
export function readBack(items: Item[], claim: Claim): Record<string, FillState> {
  const out: Record<string, FillState> = {};
  for (const f of FIELDS) {
    if (f.control === "radio") {
      const radios = items.filter((i) => i.role === "AXRadioButton" && f.options!.includes(i.text));
      const sel = radios.find((r) => r.state === "selected");
      out[f.key] = !sel ? "empty" : sel.text === claim[f.key] ? "ok" : "wrong";
      continue;
    }
    const it = items.find((i) => i.text === f.label && i.role !== "AXRadioButton");
    if (!it || it.state === "empty") out[f.key] = "empty";
    else out[f.key] = (it.value ?? "").trim() === claim[f.key] ? "ok" : "wrong";
  }
  return out;
}

export function itemByLabel(items: Item[], label: string, role?: string): Item | undefined {
  return items.find((i) => i.text === label && (!role || i.role === role));
}

export interface ActContext {
  driver: Driver;
  agent: AgentName;
  win: WindowRef;
}

export interface ActOutcome {
  desc: string;
  results: ActionResult[];
  /** set when the action was refused by our own validation (nothing was sent to the driver) */
  blocked?: string;
}

/** fill one control with the claim's value */
export async function fillControl(ctx: ActContext, it: Item, claim: Claim): Promise<ActOutcome> {
  const spec = fieldForItem(it);
  if (!spec) return { desc: `fill ${it.text}`, results: [], blocked: `no claim field matches control "${it.text}"` };
  const value = claim[spec.key];
  const { driver, agent, win } = ctx;
  if (!it.token) return { desc: `fill ${it.text}`, results: [], blocked: "control has no element token" };

  if (spec.control === "text") {
    if (it.state !== "empty") {
      return { desc: `fill ${spec.key}`, results: [], blocked: `"${it.text}" is not empty (typing would append)` };
    }
    const r = await driver.typeText(agent, win, it.token, value);
    return { desc: `type "${value}" into ${it.text}`, results: [r] };
  }

  if (spec.control === "select") {
    const results: ActionResult[] = [];
    const prefix = uniquePrefix(value, spec.options!);
    results.push(await driver.click(agent, win, it.token)); // opens the menu
    let o = await driver.observe(agent, win);
    results.push(await driver.pressKey(agent, win, "escape")); // closes it, focus stays on the select
    o = await driver.observe(agent, win);
    const again = perceive(o).find((x) => x.text === it.text && x.role === it.role);
    if (!again?.token) return { desc: `select ${value}`, results, blocked: "drop-down vanished after opening it" };
    results.push(await driver.typeText(agent, win, again.token, prefix)); // type-ahead
    return { desc: `select "${value}" in ${it.text} (type-ahead "${prefix}")`, results };
  }

  // radio
  if (it.text !== value) return { desc: `choose ${it.text}`, results: [], blocked: `claim says "${value}", not "${it.text}"` };
  const r = await driver.click(agent, win, it.token);
  return { desc: `choose "${it.text}"`, results: [r] };
}

export async function clickLabel(ctx: ActContext, items: Item[], label: string): Promise<ActOutcome> {
  const it = itemByLabel(items, label, "AXButton");
  if (!it?.token) return { desc: `click ${label}`, results: [], blocked: `no "${label}" button on the page` };
  const r = await ctx.driver.click(ctx.agent, ctx.win, it.token);
  return { desc: `click "${label}"`, results: [r] };
}

// ---------- the oracle: the form's own database ----------

export interface ServerRecord {
  id: number;
  payee: string;
  amount: string;
  date: string;
  category: string;
  paidby: string;
  t: number;
}

export class Oracle {
  constructor(private base = "http://127.0.0.1:8765") {}

  async all(): Promise<ServerRecord[]> {
    const r = await fetch(`${this.base}/api/claims`, { headers: { "Cache-Control": "no-store" } });
    if (!r.ok) throw new Error(`oracle HTTP ${r.status}`);
    return (await r.json()) as ServerRecord[];
  }

  async reset(): Promise<void> {
    await fetch(`${this.base}/api/reset`, { method: "POST" });
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  isDuplicate(records: ServerRecord[], c: Claim): boolean {
    return records.some((r) => r.payee === c.payee && r.amount === c.amount && r.date === c.date);
  }

  /** exactly one NEW record since `countBefore`, and it must match every field */
  async verify(c: Claim, countBefore: number): Promise<OracleResult> {
    const t0 = performance.now();
    const expected: Record<string, string> = { payee: c.payee, amount: c.amount, date: c.date, category: c.category, paidby: c.paidBy };
    const recs = await this.all();
    const fresh = recs.slice(countBefore);
    const ms = Math.round(performance.now() - t0);
    if (fresh.length !== 1) {
      return { ok: false, expected, observed: null, diff: [`expected 1 new record, found ${fresh.length}`], ms };
    }
    const r = fresh[0]!;
    const observed: Record<string, string> = { payee: r.payee, amount: r.amount, date: r.date, category: r.category, paidby: r.paidby };
    const diff = Object.keys(expected).filter((k) => expected[k] !== observed[k]).map((k) => `${k}: expected "${expected[k]}", form has "${observed[k]}"`);
    return { ok: diff.length === 0, expected, observed, diff, ms };
  }
}

export function pageIsClaimsForm(obs: Observation): boolean {
  return obs.elements.some((e) => e.role === "AXWebArea" && /claims form/i.test(e.label ?? ""));
}
