// The decision step. TypeSafe jev answers three typed questions per step and returns a probability for every option:
//   kind  - what kind of action makes the most progress
//   item  - which control on the page
//   field - which claim value belongs in that control
// jev never writes text: the value to type always comes from the confirmed claim.
// If TypeSafe is unreachable we fall back to PolicyClassifier, and the decision says so (backend: "policy").
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Classifier, Decision, Facts, Item, Kind } from "./contracts.ts";
import { FIELDS, CLEAR_LABEL, SUBMIT_LABEL } from "./adapters/claims-form.ts";
import { ROLE_WORDS } from "./perceive.ts";

export const GATE = 0.4;
export const PRICE_PER_TOKEN = 0.042e-6; // $0.042 per 1M input tokens, output free [docs.typesafe.ai/models]

export const KIND_CRITERIA: Record<Kind, string> = {
  fill_field: "Put the claim's value into one text field or drop-down (the item and field questions say which).",
  click_item: "Click one control, for example a radio button that is not yet chosen.",
  submit: `Press the "${SUBMIT_LABEL}" button. Only when every field already shows its correct value.`,
  clear_form: `Press "${CLEAR_LABEL}" because some field holds a wrong value.`,
  wait: "Nothing to do yet; the page is still changing.",
  done: "The claim was already submitted and the form shows a confirmation.",
  none: "Nothing on the page helps with the goal.",
};

const KIND_INSTR =
  "You are driving one web form, one action at a time. Which kind of action makes the most progress toward the goal right now? " +
  "Never repeat an action listed under already_tried_on_this_screen. Fill fields before pressing submit.";
const ITEM_INSTR = "If the next action involves a control on the page, which control is it? Choose by its label.";
const FIELD_INSTR = "Which claim value belongs in the control you chose? 'none' if the action does not enter a value.";

const humanState = (it: Item) =>
  it.state === "n/a" ? "" : it.state === "empty" ? ", empty" : it.state === "filled" ? `, shows "${it.value}"` : it.state === "selected" ? ", chosen" : ", not chosen";

export function itemCriteria(items: Item[]): Record<string, string> {
  return Object.fromEntries(items.map((it) => [String(it.i), `${ROLE_WORDS[it.role] ?? it.role} '${it.text}' (${it.where}${humanState(it)})`]));
}

export function fieldCriteria(claim: Record<string, string>): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of FIELDS) m[f.key] = `${f.label}: "${claim[f.key]}"`;
  m.none = "No claim value (clicking a button, or nothing to enter).";
  return m;
}

export function buildState(facts: Facts, items: Item[]) {
  return {
    goal: facts.goal,
    claim: facts.claim,
    which_claim_fields_are_correct_on_the_page: facts.filled,
    previous_actions: facts.previousActions,
    already_tried_on_this_screen: facts.alreadyTriedHere,
    page_controls_in_order: items.map((it) => ({ i: it.i, role: ROLE_WORDS[it.role] ?? it.role, label: it.text, state: it.state, shows: it.value || null })),
  };
}

/** the confidence that is compared with GATE: only the questions that matter for this kind */
export function gateFor(kind: Kind, kindConf: number, itemConf?: number, fieldConf?: number): number {
  if (kind === "fill_field") return Math.min(kindConf, itemConf ?? 0, fieldConf ?? 0);
  if (kind === "click_item") return Math.min(kindConf, itemConf ?? 0);
  return kindConf;
}

export class JevClassifier implements Classifier {
  readonly backend = "jev" as const;
  private client: TypeSafeClient;
  private model: string;

  private extra: { apiKey?: string; fetch?: typeof fetch };

  /** `extra` exists so tests can inject a fake fetch; production passes nothing and the key comes from TYPESAFE_API_KEY */
  constructor(model = "jev-1.13.0", extra: { apiKey?: string; fetch?: typeof fetch } = {}) {
    this.model = model;
    this.extra = extra;
    // 4 s timeout and one retry: the SDK default (10 s x 3 tries) could stall an agent for about 30 s
    this.client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: model, ...extra });
  }

  async classify(facts: Facts, items: Item[]): Promise<Decision> {
    const t0 = performance.now();
    const state = buildState(facts, items);
    const questions = {
      kind: choice(KIND_INSTR, KIND_CRITERIA),
      item: choice(ITEM_INSTR, itemCriteria(items)),
      field: choice(FIELD_INSTR, fieldCriteria(facts.claim)),
    };
    let res;
    try {
      res = await this.client.systemOne({ state, questions }).withResponse();
    } catch (e: any) {
      // a pinned model id the account can't use -> try the moving alias once
      if (this.model !== "jev-latest" && /422|model/i.test(String(e?.message ?? e))) {
        this.model = "jev-latest";
        this.client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: this.model, ...this.extra });
        res = await this.client.systemOne({ state, questions }).withResponse();
      } else throw e;
    }
    const a = res.data.answers as any;
    const kind = a.kind.choice as Kind;
    const itemN = a.item?.choice !== undefined ? Number(a.item.choice) : undefined;
    const field = a.field?.choice && a.field.choice !== "none" ? String(a.field.choice) : undefined;
    return {
      kind,
      item: Number.isFinite(itemN) ? itemN : undefined,
      field,
      kindP: a.kind.probabilities,
      itemP: a.item?.probabilities,
      fieldP: a.field?.probabilities,
      kindConf: a.kind.confidence,
      itemConf: a.item?.confidence,
      fieldConf: a.field?.confidence,
      gate: gateFor(kind, a.kind.confidence, a.item?.confidence, a.field?.confidence),
      backend: "jev",
      model: res.data.model ?? this.model,
      requestId: res.requestId ?? undefined,
      inputTokens: res.data.usage?.input_tokens ?? 0,
      ms: Math.round(performance.now() - t0),
    };
  }
}

/** Deterministic rules. NOT jev: used only when TypeSafe is unreachable, and every decision it makes is labelled. */
export class PolicyClassifier implements Classifier {
  readonly backend = "policy" as const;

  async classify(facts: Facts, items: Item[]): Promise<Decision> {
    const t0 = performance.now();
    const base = (kind: Kind, item?: number, field?: string): Decision => ({
      kind,
      item,
      field,
      kindP: { [kind]: 1 },
      kindConf: 1,
      itemConf: item === undefined ? undefined : 1,
      fieldConf: field === undefined ? undefined : 1,
      gate: 1,
      backend: "policy",
      model: "rules-v1",
      inputTokens: 0,
      ms: Math.round(performance.now() - t0),
    });
    if (Object.values(facts.filled).some((s) => s === "wrong")) return base("clear_form", items.find((i) => i.text === CLEAR_LABEL)?.i);
    for (const f of FIELDS) {
      if (facts.filled[f.key] === "ok") continue;
      if (f.control === "radio") {
        const it = items.find((i) => i.role === "AXRadioButton" && i.text === facts.claim[f.key]);
        return it ? base("click_item", it.i, f.key) : base("none");
      }
      const it = items.find((i) => i.text === f.label && i.role !== "AXRadioButton");
      return it ? base("fill_field", it.i, f.key) : base("none");
    }
    return base("submit", items.find((i) => i.text === SUBMIT_LABEL)?.i);
  }
}

/** jev first; if TypeSafe errors or times out, the labelled policy takes over for that step */
export class FallbackClassifier implements Classifier {
  readonly backend = "jev" as const;
  degraded = false;
  lastError = "";
  constructor(
    private primary: Classifier,
    private fallback: Classifier = new PolicyClassifier(),
  ) {}

  async classify(facts: Facts, items: Item[]): Promise<Decision> {
    try {
      const d = await this.primary.classify(facts, items);
      this.degraded = false;
      return d;
    } catch (e: any) {
      this.degraded = true;
      this.lastError = String(e?.message ?? e).slice(0, 200);
      return this.fallback.classify(facts, items);
    }
  }
}
