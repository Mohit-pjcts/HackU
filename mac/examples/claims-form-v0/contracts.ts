// Shared types. Everything else in src/ depends on these and nothing else depends on the implementation details.

export const AGENT = "Mint-3"; // a "-N" suffix fixes the Cua cursor colour (palette slot N)
export type AgentName = string;

export type Channel = "ax" | "synthetic" | "pixel" | "code" | "script" | "foreground";

export interface Rect { x: number; y: number; w: number; h: number }

export interface WindowRef {
  pid: number;
  windowId: number;
  app: string;
  title: string;
}

export interface AxElement {
  index: number;
  parent?: number;
  depth: number;
  token?: string;
  role: string;
  label?: string;
  value?: string;
  frame?: Rect;
  actions: string[];
}

export interface Observation {
  agent: AgentName;
  window: WindowRef;
  elements: AxElement[];
  truncated: boolean;
  degraded?: string;
  ms: number;
}

export type DriverErrorCode =
  | "permissions_pending"
  | "session_ended"
  | "stale_element_token"
  | "keyboard_ambiguity"
  | "minimized_or_hidden"
  | "ax_window_unresolved"
  | "refused"
  | "timeout"
  | "daemon_down"
  | "other";

export interface ActionResult {
  /** true = not refused and no error. It NEVER means "it worked". Only the oracle decides that. */
  ok: boolean;
  effect?: string;
  route?: string;
  channel: Channel;
  error?: { code: DriverErrorCode; detail: string };
  ms: number;
  cli: string;
}

export interface Driver {
  ensureSession(agent: AgentName): Promise<void>;
  listWindows(): Promise<{ windows: WindowRaw[] }>;
  launchApp(agent: AgentName, bundleId: string, urls: string[]): Promise<{ pid: number }>;
  observe(agent: AgentName, w: WindowRef, opts?: { timeoutMs?: number }): Promise<Observation>;
  click(agent: AgentName, w: WindowRef, token: string): Promise<ActionResult>;
  typeText(agent: AgentName, w: WindowRef, token: string, text: string): Promise<ActionResult>;
  pressKey(agent: AgentName, w: WindowRef, key: "escape" | "tab" | "return"): Promise<ActionResult>;
  endAll(): Promise<void>;
}

export interface WindowRaw {
  app_name: string;
  title: string;
  pid: number;
  window_id: number;
  bounds: { x: number; y: number; width: number; height: number };
  is_on_screen?: boolean;
  on_current_space?: boolean | null;
}

// ---------- perception + decision ----------

export interface Item {
  i: number;
  id: string; // `${role}:${label}`, stable across steps
  text: string; // label
  role: string;
  token?: string;
  value?: string;
  state: "empty" | "filled" | "selected" | "unselected" | "n/a";
  where: string;
}

export type FillState = "ok" | "wrong" | "empty";

export interface Facts {
  goal: string;
  claim: Record<string, string>;
  filled: Record<string, FillState>;
  previousActions: string[];
  alreadyTriedHere: string[];
}

export type Kind = "fill_field" | "click_item" | "submit" | "clear_form" | "wait" | "done" | "none";

export interface Decision {
  kind: Kind;
  item?: number;
  field?: string;
  kindP: Record<string, number>;
  itemP?: Record<string, number>;
  fieldP?: Record<string, number>;
  kindConf: number;
  itemConf?: number;
  fieldConf?: number;
  /** the number compared with the gate (min over the questions that matter for this kind) */
  gate: number;
  backend: "jev" | "policy" | "replay" | "code";
  model: string;
  requestId?: string;
  inputTokens: number;
  ms: number;
}

export interface Classifier {
  readonly backend: Decision["backend"];
  classify(facts: Facts, items: Item[]): Promise<Decision>;
}

// ---------- the batch ----------

export interface Claim {
  payee: string;
  amount: string; // "128.50"
  date: string; // DD/MM/YYYY
  category: string;
  paidBy: string; // "FPS" | "Cash"
}

export type ExceptionCode =
  | "over_mandate"
  | "duplicate"
  | "unparseable_date"
  | "missing_field"
  | "low_confidence"
  | "stalled"
  | "step_limit"
  | "driver_refused"
  | "page_lost"
  | "field_mismatch"
  | "false_done"
  | "oracle_mismatch"
  | "stopped";

export interface OracleResult {
  ok: boolean;
  expected: Record<string, string>;
  observed: Record<string, string> | null;
  diff: string[];
  ms: number;
}

export interface Counts {
  gui: number;
  code: number;
  script: number;
  foreground: number;
  decisions: number;
  falseDoneCaught: number;
  submitBlocked: number;
}

export interface BatchItem {
  id: string;
  source: "seed" | "typed" | "voice";
  raw: string;
  claim?: Claim;
  status: "pending" | "running" | "verified" | "exception";
  exception?: { code: ExceptionCode; reason: string };
  proof?: OracleResult;
  steps: number;
  costUsd: number;
  seconds: number;
  counts: Counts;
}

export interface Report {
  runId: string;
  verified: BatchItem[];
  exceptions: BatchItem[];
  costUsd: number;
  seconds: number;
  counts: Counts;
  classifier: Decision["backend"];
}

// ---------- the JSONL run log ----------

export type LogLine =
  | { type: "run_start"; runId: string; t: string; classifier: Decision["backend"]; model: string; items: BatchItem[] }
  | { type: "prepare"; runId: string; t: string; itemId: string; results: ActionResult[] }
  | {
      type: "step";
      runId: string;
      t: string;
      agent: AgentName;
      itemId: string;
      step: number;
      items: Item[];
      facts: Facts;
      decision: Decision;
      acted: string;
      results: ActionResult[];
      ms: { observe: number; decide: number; act: number };
    }
  | { type: "readback"; runId: string; t: string; itemId: string; filled: Record<string, FillState>; pass: boolean }
  | { type: "guard"; runId: string; t: string; itemId: string; rule: string; detail: string }
  | { type: "oracle"; runId: string; t: string; itemId: string; phase: "final" | "after_done"; result: OracleResult }
  | { type: "item_end"; runId: string; t: string; item: BatchItem }
  | { type: "run_end"; runId: string; t: string; report: Report };

export interface Logger {
  write(line: LogLine): void;
}

export const emptyCounts = (): Counts => ({
  gui: 0,
  code: 0,
  script: 0,
  foreground: 0,
  decisions: 0,
  falseDoneCaught: 0,
  submitBlocked: 0,
});
