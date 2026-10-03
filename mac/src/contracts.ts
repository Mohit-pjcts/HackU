// Shared types for the multi-agent engine.

/** Cua Driver colours a session cursor by the "-N" suffix of its label (palette slot N). */
export const AGENT_NAMES = ["Mint-3", "Red-7", "Blue-9", "Amber-4", "Purple-1", "Cyan-5", "Pink-2", "Lime-8", "Magenta-6"] as const;
export const AGENT_COLOURS: Record<string, string> = {
  "Purple-1": "#a259ff", "Pink-2": "#ff5fa2", "Mint-3": "#2bb39a", "Amber-4": "#f5a623", "Cyan-5": "#22c3e6",
  "Magenta-6": "#d63bd6", "Red-7": "#ff4d4f", "Lime-8": "#8fd400", "Blue-9": "#3b82f6",
};
export type AgentName = string;
export type Channel = "ax" | "synthetic" | "pixel" | "foreground";

export interface Rect { x: number; y: number; w: number; h: number }
export interface WindowRef { pid: number; windowId: number; app: string; title: string }
export interface WindowRaw {
  app_name: string; title: string; pid: number; window_id: number;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean; on_current_space?: boolean | null;
}
export interface AppInfo { name: string; bundle_id: string; running: boolean; pid?: number }

export interface AxElement {
  index: number; parent?: number; depth: number; token?: string; role: string;
  label?: string; value?: string; frame?: Rect; actions: string[];
}
export interface Observation {
  agent: AgentName; window: WindowRef; elements: AxElement[]; truncated: boolean; degraded?: string; ms: number;
  /** Cua's markdown rendering of the tree: the only place non-actionable text (e.g. Calculator's display) appears */
  markdown?: string;
}

export type DriverErrorCode =
  | "permissions_pending" | "session_ended" | "stale_element_token" | "keyboard_ambiguity"
  | "minimized_or_hidden" | "background_unavailable" | "refused" | "timeout" | "other";

export interface ActionResult {
  /** not refused and no error. It NEVER means "it worked": the next observation (and the verifier) decide that */
  ok: boolean; effect?: string; route?: string; channel: Channel;
  error?: { code: DriverErrorCode; detail: string }; ms: number; cli: string;
}

export interface Driver {
  ensureSession(agent: AgentName): Promise<void>;
  listWindows(): Promise<{ windows: WindowRaw[] }>;
  listApps(): Promise<AppInfo[]>;
  launchApp(agent: AgentName, bundleId: string, urls?: string[], opts?: { newInstance?: boolean; args?: string[] }): Promise<{ pid: number }>;
  observe(agent: AgentName, w: WindowRef, opts?: { timeoutMs?: number; maxDepth?: number }): Promise<Observation>;
  click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult>;
  /** foreground=true briefly brings the window to the front (counted and shown): the fallback when background input is refused */
  typeText(agent: AgentName, w: WindowRef, token: string, text: string, foreground?: boolean): Promise<ActionResult>;
  pressKey(agent: AgentName, w: WindowRef, key: "escape" | "tab" | "return", token?: string, foreground?: boolean): Promise<ActionResult>;
  scroll(agent: AgentName, w: WindowRef, direction: "up" | "down", token?: string): Promise<ActionResult>;
  /** AXConfirm on a field: "press Enter" without the keyboard (works when keys are refused) */
  confirm(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult>;
  setValue(agent: AgentName, w: WindowRef, token: string, value: string): Promise<ActionResult>;
  /** put text on the clipboard and Cmd+V it into the field (optional: drivers without a clipboard skip it) */
  paste?(agent: AgentName, w: WindowRef, token: string, text: string): Promise<ActionResult>;
  endSession(agent: AgentName): Promise<void>;
}

// ---------- perception + decision ----------

export interface Item {
  i: number; id: string; text: string; role: string; token?: string; value?: string;
  state: "empty" | "filled" | "selected" | "unselected" | "n/a";
  actions?: string[];
}

export interface Facts {
  goal: string;
  app: string;
  screenText: string[];
  previousActions: string[];
  alreadyTriedHere: string[];
  /** set when the verifier said "not achieved yet" */
  notDoneReason?: string;
  /** the LLM's one-off plan for this task, and how far along it we are */
  plan?: PlanStep[];
  planPos?: number;
}

export interface PlanStep {
  action: "click" | "type" | "press_enter" | "press_escape" | "scroll_down" | "scroll_up" | "open_url" | "make_folder" | "move_file" | "sort_into" | "save_as" | "pick_city";
  target?: string;
  text?: string;
}
export const stepText = (s: PlanStep) => `${s.action.replace("_", " ")}${s.target ? ` '${s.target}'` : ""}${s.text !== undefined ? ` with text "${s.text}"` : ""}`;

export const KINDS = ["click", "type_text", "press_enter", "press_escape", "scroll_down", "scroll_up", "wait", "done", "none"] as const;
export type Kind = (typeof KINDS)[number];

export type BrainKind = "jev" | "llm";

export interface Decision {
  kind: Kind;
  item?: number;
  /** only the LLM brain proposes text itself; the jev brain asks the writer */
  text?: string;
  kindP?: Record<string, number>;
  itemP?: Record<string, number>;
  kindConf: number;
  itemConf?: number;
  /** the number compared with the gate */
  gate: number;
  backend: BrainKind | "replay" | "code";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
}

export interface Choice { choice: string; confidence: number; probs?: Record<string, number>; costUsd: number; ms: number }

export interface Brain {
  readonly kind: BrainKind;
  readonly model: string;
  classify(facts: Facts, items: Item[]): Promise<Decision>;
  /** one typed question (e.g. "which folder does this file belong in?"): the cheap classifier's home ground */
  choose?(question: string, options: Record<string, string>, state: object): Promise<Choice>;
}

/** free-text and verification helpers (an LLM, called only when needed) */
export interface Helper {
  plan(goal: string, app: string, screenText: string[], items: Item[], why?: string, files?: string[]): Promise<{ steps: PlanStep[]; costUsd: number; ms: number }>;
  /** optional: remember a plan that led to a verified success */
  remember?(app: string, goal: string, steps: PlanStep[]): void;
  /** optional: where the last plan came from */
  lastSource?: string;
  writeText(goal: string, field: Item, screenText: string[], previous: string[]): Promise<{ text: string; costUsd: number; ms: number; llm?: boolean }>;
  /** before = the screen text when the task started: evidence that was already there does not count for tasks that DO something */
  verify(goal: string, screenText: string[], items: Item[], before?: string[], opts?: { acted?: boolean }): Promise<{ achieved: boolean; answer: string; reason: string; costUsd: number; ms: number; llm?: boolean }>;
  /** true if this helper can call an LLM when jev is stuck */
  canEscalate?: boolean;
}

// ---------- tasks ----------

export type ExceptionCode =
  | "no_app" | "window_lost" | "low_confidence" | "stalled" | "step_limit"
  | "driver_refused" | "not_achieved" | "stopped" | "error";

export interface Task {
  id: string;
  agent: AgentName;
  app: string;
  bundleId?: string;
  goal: string;
  brain: BrainKind;
  status: "queued" | "running" | "done" | "failed";
  answer?: string;
  exception?: { code: ExceptionCode; reason: string };
  steps: number;
  seconds: number;
  cost: { decisionsUsd: number; helperUsd: number };
  plan?: PlanStep[];
  counts: { decisions: number; actions: number; helperCalls: number; gated: number; foreground: number; scripted: number };
  /** every LLM call this task needed, with the reason (empty = done by jev and code alone) */
  llmCalls: string[];
  decideMs: number[];
  now?: string;
  /** the window the agent works in (for the live preview in its widget) */
  windowId?: number;
}

export interface RunTotals {
  tasks: number; done: number; failed: number; seconds: number;
  decisionsUsd: number; helperUsd: number; decisions: number; actions: number;
  medianDecideMs: number;
}

export type LogLine =
  | { type: "run_start"; runId: string; t: string; command: string; brain: BrainKind; tasks: Task[] }
  | {
      type: "step"; runId: string; t: string; taskId: string; agent: AgentName; step: number;
      items: Item[]; decision: Decision; acted: string; results: ActionResult[];
      ms: { observe: number; decide: number; act: number }; truncated?: boolean;
    }
  | { type: "helper"; runId: string; t: string; taskId: string; agent: AgentName; what: "plan" | "write" | "verify"; detail: string; costUsd: number; ms: number }
  | { type: "task_end"; runId: string; t: string; task: Task }
  | { type: "run_end"; runId: string; t: string; totals: RunTotals; tasks: Task[] };

export interface Logger { write(line: LogLine): void }
