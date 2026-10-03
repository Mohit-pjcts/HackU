// Two interchangeable "brains" that choose the next action from the SAME text description of the window:
//   JevBrain - TypeSafe jev: typed questions, a probability per option, ~$0.00005 and ~0.5 s per decision (measured)
//   LlmBrain - Claude (Sonnet by default), the usual way agents decide; used to compare cost and speed honestly
// plus ClaudeHelper: writes free text for a field and checks "is the goal achieved?" (called only when needed).
import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Brain, Choice, Decision, Facts, Helper, Item, Kind, PlanStep } from "./contracts.ts";
import { KINDS, stepText } from "./contracts.ts";
import { HELPER_MODEL, LLM_BRAIN_MODEL, callTool } from "./llm.ts";
import { ROLE_WORDS, TEXT_INPUT, relevantLines } from "./perceive.ts";

export const GATE = 0.4;
export const JEV_PRICE_PER_TOKEN = 0.042e-6; // $0.042 per 1M input tokens, output free [docs.typesafe.ai/models]

export const KIND_CRITERIA: Record<Kind, string> = {
  click: "Click one control on the screen (the item question says which one).",
  type_text: "Type text into a text field (the item question says which field). Only when that field still needs text.",
  press_enter: "Press Return to confirm or submit what was just typed.",
  press_escape: "Press Escape to close a menu, popover or dialog that is in the way.",
  scroll_down: "Scroll down to reveal more of the window.",
  scroll_up: "Scroll up.",
  wait: "The window is still changing (loading); wait a moment.",
  done: "The goal is already achieved: the screen shows the requested result.",
  none: "Nothing on this screen can make progress toward the goal.",
};

const KIND_INSTR =
  "You operate one app window, one action at a time, to achieve the goal. Which kind of action makes the most progress right now? " +
  "Normally this is the next_planned_step. Choose done only when the screen shows the goal achieved. " +
  "Never repeat an action listed in already_tried_on_this_screen.";
const ITEM_INSTR = "Which control on the screen does the next action use? Match the next_planned_step's target to a control label.";

const stateWord = (it: Item) =>
  it.state === "empty" ? ", empty" : it.state === "filled" ? `, contains "${(it.value ?? "").slice(0, 40)}"` : it.state === "selected" ? ", selected" : it.state === "unselected" ? ", not selected" : "";

export function itemCriteria(items: Item[]): Record<string, string> {
  return Object.fromEntries(items.map((it) => [String(it.i), `${ROLE_WORDS[it.role] ?? it.role} '${it.text}'${stateWord(it)}`]));
}

export function buildState(f: Facts, items: Item[]) {
  return {
    goal: f.goal,
    app: f.app,
    text_on_screen: relevantLines(f.screenText, f.goal, 40),
    previous_actions: f.previousActions.slice(-8),
    already_tried_on_this_screen: f.alreadyTriedHere,
    ...(f.notDoneReason ? { not_done_yet_because: f.notDoneReason } : {}),
    ...(f.plan && f.plan.length
      ? {
          plan: f.plan.map(stepText),
          steps_already_done: f.plan.slice(0, f.planPos ?? 0).map(stepText),
          next_planned_step: (f.planPos ?? 0) < f.plan.length ? stepText(f.plan[f.planPos ?? 0]!) : "all planned steps are done: check the screen",
        }
      : {}),
    controls: items.map((it) => ({ i: it.i, control: `${ROLE_WORDS[it.role] ?? it.role} '${it.text}'${stateWord(it)}` })),
  };
}

export function gateFor(kind: Kind, kindConf: number, itemConf?: number): number {
  if (kind === "click" || kind === "type_text") return Math.min(kindConf, itemConf ?? 0);
  return kindConf;
}

export class JevBrain implements Brain {
  async choose(question: string, options: Record<string, string>, state: object): Promise<Choice> {
    const t0 = performance.now();
    const res = await this.client.systemOne({ state, questions: { q: choice(question, options) } } as any).withResponse();
    const a = (res.data.answers as any).q;
    const tokens = res.data.usage?.input_tokens ?? 0;
    return { choice: String(a.choice), confidence: a.confidence, probs: a.probabilities, costUsd: tokens * JEV_PRICE_PER_TOKEN, ms: Math.round(performance.now() - t0) };
  }

  readonly kind = "jev" as const;
  model: string;
  private client: TypeSafeClient;
  private extra: { apiKey?: string; fetch?: typeof fetch };

  constructor(model = "jev-1.13.0", extra: { apiKey?: string; fetch?: typeof fetch } = {}) {
    this.model = model;
    this.extra = extra;
    // 4 s timeout, one retry: the SDK default (10 s x 3 tries) could stall an agent ~30 s
    this.client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: model, ...extra });
  }

  async classify(facts: Facts, items: Item[]): Promise<Decision> {
    const t0 = performance.now();
    const state = buildState(facts, items);
    const questions: Record<string, ReturnType<typeof choice>> = { kind: choice(KIND_INSTR, KIND_CRITERIA) };
    if (items.length) questions.item = choice(ITEM_INSTR, itemCriteria(items));
    let res;
    try {
      res = await this.client.systemOne({ state, questions } as any).withResponse();
    } catch (e: any) {
      if (this.model !== "jev-latest" && /422|model/i.test(String(e?.message ?? e))) {
        this.model = "jev-latest";
        this.client = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: this.model, ...this.extra });
        res = await this.client.systemOne({ state, questions } as any).withResponse();
      } else throw e;
    }
    const a = res.data.answers as any;
    const kind = a.kind.choice as Kind;
    const item = a.item ? Number(a.item.choice) : undefined;
    const inputTokens = res.data.usage?.input_tokens ?? 0;
    return {
      kind,
      item: Number.isFinite(item) ? item : undefined,
      kindP: a.kind.probabilities,
      itemP: a.item?.probabilities,
      kindConf: a.kind.confidence,
      itemConf: a.item?.confidence,
      gate: gateFor(kind, a.kind.confidence, a.item?.confidence),
      backend: "jev",
      model: (res.data as any).model ?? this.model,
      inputTokens,
      outputTokens: 0,
      costUsd: inputTokens * JEV_PRICE_PER_TOKEN,
      ms: Math.round(performance.now() - t0),
    };
  }
}

const LLM_SYSTEM =
  "You operate one macOS app window for the user, one action at a time, to achieve their goal. You see the window as a list of numbered controls and the text on screen. " +
  "Choose the single next action. For type_text, give the exact text to type (it is inserted at the cursor, it does not replace). " +
  "Use previous_actions to avoid repeating yourself. Choose done only when the screen shows the goal is achieved. " +
  "Never edit, delete or overwrite the user's existing content unless the goal explicitly says so.";

export class LlmBrain implements Brain {
  readonly kind = "llm" as const;
  constructor(readonly model = LLM_BRAIN_MODEL) {}

  async choose(question: string, options: Record<string, string>, state: object): Promise<Choice> {
    const keys = Object.keys(options);
    const r = await callTool<{ choice: string; confidence: number }>({
      model: this.model,
      system: "Answer the question by choosing exactly one option key.",
      user: JSON.stringify({ question, options, state }),
      tool: { name: "answer", description: "Your choice.", input_schema: { type: "object", properties: { choice: { type: "string", enum: keys }, confidence: { type: "number" } }, required: ["choice", "confidence"] } },
    });
    return { choice: keys.includes(r.input.choice) ? r.input.choice : keys[keys.length - 1]!, confidence: Number(r.input.confidence ?? 0), costUsd: r.costUsd, ms: r.ms };
  }

  async classify(facts: Facts, items: Item[]): Promise<Decision> {
    const r = await callTool<{ kind: Kind; item?: number | null; text?: string | null; confidence: number }>({
      model: this.model,
      system: LLM_SYSTEM,
      user: JSON.stringify(buildState(facts, items)),
      tool: {
        name: "choose_action",
        description: "The next action for the agent.",
        input_schema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...KINDS], description: Object.entries(KIND_CRITERIA).map(([k, v]) => `${k}: ${v}`).join(" ") },
            item: { type: ["integer", "null"], description: "the control number for click/type_text/press_enter, else null" },
            text: { type: ["string", "null"], description: "for type_text: the exact text to type" },
            confidence: { type: "number", description: "0..1, how sure you are" },
          },
          required: ["kind", "item", "text", "confidence"],
        },
      },
    });
    const kind = (KINDS as readonly string[]).includes(r.input.kind) ? r.input.kind : "none";
    const conf = Math.max(0, Math.min(1, Number(r.input.confidence ?? 0)));
    return {
      kind,
      item: r.input.item ?? undefined,
      text: r.input.text ?? undefined,
      kindConf: conf,
      itemConf: conf,
      gate: conf, // self-reported, not calibrated: kept for display; the gate is not applied to the LLM arm
      backend: "llm",
      model: this.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      ms: r.ms,
    };
  }
}

export class ClaudeHelper implements Helper {
  constructor(readonly model = HELPER_MODEL) {}

  /** ONE call per task (plus one per re-plan): the concrete steps. jev then grounds and executes each one. */
  async plan(goal: string, app: string, screen: string[], items: Item[], why?: string, _files?: string[]) {
    const r = await callTool<{ steps: PlanStep[] }>({
      model: this.model,
      system:
        "You plan the exact UI actions for an agent that operates ONE macOS app window through its accessibility controls. " +
        "Use only controls that exist in the list (use their exact labels as target). One action per step. Keyboard shortcuts are NOT available. " +
        "To go to a website, use ONE open_url step with the full URL as text (never type URLs into an address bar). " +
        "For a web search, prefer ONE open_url with a URL that already encodes the query (https://www.google.com/search?q=..., https://en.wikipedia.org/w/index.php?search=..., https://www.google.com/travel/flights?q=...) instead of filling search forms, which use pop-up suggestions the agent cannot see. " +
        "target must be EXACTLY one of the quoted labels in controls (not a role word such as 'text area'). " +
        "Prefer clicking a Search / Go / Send / Submit button over press_enter. " +
        "FINDER: files cannot be dragged or renamed through the GUI here. To organise the files of the open folder use ONE sort_into step whose text is the comma-separated list of folder names to sort into (e.g. \"PDFs, Images, Documents\"); for a single file use make_folder (text = folder name) and move_file (target = file name, text = folder name). " +
        "SAFETY: never edit, delete or overwrite the user's existing content (notes, documents, messages) unless the goal explicitly says so; create a new item instead (for example click New Note first). " +
        "For text, use ONE type step directly on the text field or text area with the exact text (do not click the field first). " +
        "For several lines in one text area (a note, a list, a document), use ONE type step whose text contains \\n line breaks; never press_enter between lines. " +
        "To submit a search or form field, add press_enter after typing. Keep it short; no checking steps. " +
        "If the goal only asks to read or report something and it is already in text_on_screen, return zero steps.",
      user: JSON.stringify({ goal, app, ...(why ? { previous_attempt_failed_because: why } : {}), text_on_screen: relevantLines(screen, goal, 60), controls: items.map((i) => `"${i.text}" (${ROLE_WORDS[i.role] ?? i.role}${i.value ? `, contains "${i.value.slice(0, 40)}"` : ""})`) }),
      tool: {
        name: "plan",
        description: "The steps.",
        input_schema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["click", "type", "press_enter", "press_escape", "scroll_down", "scroll_up", "open_url", "make_folder", "move_file", "sort_into"] },
                  target: { type: "string", description: "exact control label" },
                  text: { type: "string", description: "for type: the exact text" },
                },
                required: ["action"],
              },
            },
          },
          required: ["steps"],
        },
      },
      maxTokens: 900,
    });
    // the model sometimes copies the list's role prefix ("button 'Clear'"): keep only the label
    const valid = new Set(["click", "type", "press_enter", "press_escape", "scroll_down", "scroll_up", "open_url", "make_folder", "move_file", "sort_into"]);
    const steps = (r.input.steps ?? [])
      .filter((st) => valid.has(st.action)) // e.g. a "cmd+a" step is impossible here: drop it
      .slice(0, 30)
      .map((st) => {
        let t = st.target?.trim();
        const quoted = t?.match(/^"([^"]+)"/); // the model may copy the whole decorated entry: '"New Note" (button)'
        if (quoted) t = quoted[1];
        t = t?.replace(/^[a-z][a-z -]* '(.*)'$/i, "$1").replace(/^["'](.*)["']$/, "$1");
        return { ...st, target: t };
      });
    // a target that is only a role word ("text area") -> the one control of that role, if there is exactly one
    for (const st of steps) {
      if (!st.target || items.some((i) => i.text === st.target)) continue;
      const byRole = items.filter((i) => (ROLE_WORDS[i.role] ?? "") === st.target!.toLowerCase());
      if (byRole.length === 1) st.target = byRole[0]!.text;
    }
    return { steps, costUsd: r.costUsd, ms: r.ms };
  }

  async writeText(goal: string, field: Item, screen: string[], previous: string[]) {
    const r = await callTool<{ text: string }>({
      model: this.model,
      system: "You fill one text field for an agent operating a macOS app. Reply with only the text to type. It is inserted at the cursor and does not replace existing text. " +
        "The newest content is at the END of text_on_screen: when the goal is to reply to someone, answer their newest message there, naturally and briefly, as the user.",
      user: JSON.stringify({ goal, field: `${ROLE_WORDS[field.role] ?? field.role} '${field.text}'`, field_currently_contains: field.value ?? "", text_on_screen: [...new Set([...relevantLines(screen, goal, 20), ...screen.slice(-25)])], previous_actions: previous.slice(-8) }),
      tool: { name: "type", description: "The text to type.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
      maxTokens: 2500, // a document (a 7-day itinerary) is ~1,000-1,500 tokens: at 600 the answer was cut off and came back empty
    });
    return { text: String(r.input.text ?? ""), costUsd: r.costUsd, ms: r.ms };
  }

  async verify(goal: string, screen: string[], items: Item[], before?: string[], _opts?: { acted?: boolean }) {
    const r = await callTool<{ achieved: boolean; answer: string; reason: string }>({
      model: this.model,
      system:
        "You check whether an agent achieved the user's goal, using ONLY the text visible in the app window. Be strict: if the evidence is not on screen, it is not achieved. " +
        "If the goal asks the agent to DO something (create, write, send, ask, play, compute, add), it counts only if the evidence is NEW: text that was already on screen before the task started (text_before_task) is an earlier result, not this task's. " +
        "If the goal only asks to find or report information, earlier text is fine. If the goal asks for a value, put it in answer. " +
        "Feeds and lists (a home page's videos, search results) change every time the page loads: 'the first video' means the first one on the page as the agent saw it during the task, not the first one in text_before_task. " +
        "Text on screen cannot show formatting (checkboxes, bold, tables): if the goal requires a format you cannot confirm, set achieved=false unless everything else is clearly done, and ALWAYS say in answer what you could not confirm.",
      user: JSON.stringify({ goal, ...(before ? { text_before_task: relevantLines(before, goal, 60, 10) } : {}), text_on_screen: relevantLines(screen, goal, 150, 20), controls: items.slice(0, 40).map((i) => `${i.text}${i.value ? ` = "${i.value.slice(0, 80)}"` : ""}`) }),
      tool: {
        name: "verdict",
        description: "Whether the goal is achieved.",
        input_schema: {
          type: "object",
          properties: { achieved: { type: "boolean" }, answer: { type: "string", description: "the requested value or a one-line summary" }, reason: { type: "string" } },
          required: ["achieved", "answer", "reason"],
        },
      },
    });
    return { achieved: !!r.input.achieved, answer: String(r.input.answer ?? ""), reason: String(r.input.reason ?? ""), costUsd: r.costUsd, ms: r.ms };
  }
}

export const isTextInput = (it: Item | undefined) => !!it && TEXT_INPUT.has(it.role);
