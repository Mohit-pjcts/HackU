// Generic perception for ANY app window: accessibility elements -> (a) a short numbered list of things the agent can act
// on, (b) the text on screen. No screenshots, no OCR, no model: this is pure code and costs nothing.
import type { AxElement, Item, Observation } from "./contracts.ts";

export const CAP = 40;

export const ACTIONABLE = new Set([
  "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXCheckBox", "AXRadioButton",
  "AXPopUpButton", "AXMenuButton", "AXLink", "AXCell", "AXTab", "AXDisclosureTriangle", "AXSlider", "AXIncrementor",
  "AXImage", // Finder's file and folder icons (only those that can be opened are kept, see below)
]);
export const TEXT_INPUT = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);

export const ROLE_WORDS: Record<string, string> = {
  AXButton: "button", AXTextField: "text field", AXTextArea: "text area", AXSearchField: "search field",
  AXComboBox: "combo box", AXCheckBox: "checkbox", AXRadioButton: "radio button", AXPopUpButton: "drop-down",
  AXMenuButton: "menu button", AXLink: "link", AXCell: "row", AXTab: "tab", AXDisclosureTriangle: "disclosure",
  AXSlider: "slider", AXIncrementor: "stepper", AXImage: "file",
};

const junkLabel = (s: string | undefined) => !s || !s.trim() || /^_NS:\d+$/.test(s.trim()) || /^_SC_/.test(s.trim());
/** internal class names leaking as labels, e.g. "ICMNoteListCell": better to describe the row by its text */
const classLike = (s: string) => /^[A-Z]{2,}[A-Za-z]+(Cell|View|Row|Item)[A-Za-z]*$/.test(s.trim());

/** elements of the window itself (the app's menu bar is excluded: menus are not driven by clicks here) */
export function windowElements(obs: Observation): AxElement[] {
  const byIndex = new Map(obs.elements.map((e) => [e.index, e] as const));
  const memo = new Map<number, boolean>();
  const inWindow = (e: AxElement): boolean => {
    const m = memo.get(e.index);
    if (m !== undefined) return m;
    let r: boolean;
    if (e.role === "AXMenuBar") r = false;
    else if (e.role === "AXWindow") r = true;
    else if (e.parent === undefined) r = false;
    else {
      const p = byIndex.get(e.parent);
      r = p ? inWindow(p) : false;
    }
    memo.set(e.index, r);
    return r;
  };
  return obs.elements.filter((e) => e.role !== "AXWindow" && inWindow(e));
}

function stateOf(e: AxElement): Item["state"] {
  if (TEXT_INPUT.has(e.role)) return e.value && e.value.trim() !== "" ? "filled" : "empty";
  if (e.role === "AXCheckBox" || e.role === "AXRadioButton") return e.value === "1" ? "selected" : "unselected";
  return "n/a";
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** text from Cua's markdown tree (it includes static text that the element list leaves out); menu bar skipped */
export function screenFromMarkdown(md: string, max = 600): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let skipIndent = -1;
  for (const raw of md.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    if (skipIndent >= 0 && indent > skipIndent) continue;
    skipIndent = -1;
    if (/\bAXMenuBar\b/.test(line)) { skipIndent = indent; continue; }
    const m = line.match(/^- (?:\[\d+\] )?AX(StaticText|Heading|TextField|TextArea|Cell|Link|Button|GenericElement)\b(?: \(([^)]*)\))?(?: = "(.*)")?/);
    if (!m) continue;
    const role = m[1]!;
    // SwiftUI apps (Maps, Weather, Stocks) put their information in generic elements: "29 min, 11:56 ETA · 35 km"
    const texts = role === "StaticText" || role === "Heading" || role === "GenericElement" ? [m[3], m[2]] : role === "TextField" || role === "TextArea" ? [m[3]] : [];
    for (const s of texts) {
      const t = (s ?? "").replace(BIDI, "").replace(/\s+/g, " ").trim();
      if (!t || seen.has(t) || /^_NS:/.test(t)) continue;
      seen.add(t);
      out.push(t.length > 160 ? t.slice(0, 157) + "..." : t);
    }
    if (out.length >= max) break;
  }
  return out;
}

/** text visible in the window (static text and values), deduplicated, for reading answers and judging progress */
export function screenText(els: AxElement[], max = 600): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    for (const s of e.role === "AXStaticText" || e.role === "AXHeading" || e.role === "AXGenericElement" ? [e.value, e.label] : TEXT_INPUT.has(e.role) ? [e.value] : []) {
      const t = (s ?? "").replace(/\s+/g, " ").trim();
      if (!t || seen.has(t) || /^_NS:/.test(t)) continue;
      seen.add(t);
      out.push(t.length > 160 ? t.slice(0, 157) + "..." : t);
    }
    if (out.length >= max) break;
  }
  return out;
}

export interface Perceived { items: Item[]; screen: string[]; dropped: number }

/** items ranked: things whose words appear in the goal first, then text inputs, then the rest in reading order */
export function perceive(obs: Observation, goal = "", cap = CAP, focus = ""): Perceived {
  const els = windowElements(obs);
  const goalWords = new Set(words(goal));
  const focusWords = new Set(words(focus));
  const focusNorm = focus.trim().toLowerCase();
  const cands: { e: AxElement; label: string; score: number; order: number }[] = [];
  const seen = new Set<string>();
  els.forEach((e, order) => {
    if (!ACTIONABLE.has(e.role) || !e.token) return;
    if (e.role === "AXImage" && !e.actions.includes("AXOpen")) return; // decorative images
    let label = junkLabel(e.label) ? "" : e.label!.trim();
    if (label && classLike(label)) label = e.value?.trim() ? `${ROLE_WORDS[e.role] ?? e.role} "${e.value.trim().slice(0, 50)}"` : "";
    if (!label && TEXT_INPUT.has(e.role)) label = e.value?.trim() ? `${ROLE_WORDS[e.role]} containing "${e.value.trim().slice(0, 40)}"` : `${ROLE_WORDS[e.role]} (no label)`;
    if (!label) return;
    const id = `${e.role}:${label}`;
    if (seen.has(id)) return;
    seen.add(id);
    const lw = words(label);
    const overlap = lw.filter((w) => goalWords.has(w)).length;
    // the plan's next target is what the agent needs right now: make sure it survives the cap
    const focusHit = focusNorm && label.toLowerCase() === focusNorm ? 1000 : lw.filter((w) => focusWords.has(w)).length * 30;
    const score = focusHit + overlap * 10 + (TEXT_INPUT.has(e.role) ? 3 : 0);
    cands.push({ e, label, score, order });
  });
  const kept = [...cands].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, cap);
  kept.sort((a, b) => a.order - b.order); // present in reading order
  const items: Item[] = kept.map((c, i) => ({
    i, id: `${c.e.role}:${c.label}`, text: c.label, role: c.e.role, token: c.e.token, value: c.e.value, state: stateOf(c.e), actions: c.e.actions,
  }));
  let screen = obs.markdown ? screenFromMarkdown(obs.markdown) : screenText(els);
  // multi-line field contents (a document, a note) don't survive the markdown rendering: add them in full
  const seenLines = new Set(screen);
  const extra: string[] = [];
  for (const e of els) {
    if (!TEXT_INPUT.has(e.role) || !e.value) continue;
    for (const line of e.value.split(/\n+/)) {
      const t = line.replace(BIDI, "").trim();
      if (t && !seenLines.has(t)) { seenLines.add(t); extra.push(t.length > 160 ? t.slice(0, 157) + "..." : t); }
    }
  }
  // the window title is evidence too (a video page is titled "... - YouTube", a document by its file name)
  screen = [...(obs.window.title ? [`window title: ${obs.window.title}`] : []), ...screen, ...extra.slice(0, 200)];
  return { items, screen, dropped: cands.length - kept.length };
}

/** a cheap fingerprint of the window, used to detect "nothing changed" */
export function signature(p: Perceived): string {
  return p.items.map((i) => `${i.id}=${i.value ?? ""}`).join("|") + "#" + p.screen.join("|");
}

/** the n lines most useful for a goal: the first few (titles, displays) plus the ones sharing the most words with it */
/** what an answer to the question LOOKS like ("what time" -> 8:00 p.m.), for lines that share no words with it */
const ANSWER_SHAPES: [RegExp, RegExp][] = [
  [/\bwhat time\b|\bwhen does\b|\bopening hours\b|\bopen until\b|\bstarts?\b|\bcloses?\b/i, /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)|\b\d{1,2}:\d{2}\b|\bo'clock\b|\(\d{2}:\d{2}\)/i],
  [/\bhow much\b|\bprice\b|\bcost\b|\bfee\b|\bin (hong kong |us |hk )?dollars\b|\bexchange\b/i, /[$¥€£]|\bHK\$|\b(HKD|USD|JPY|EUR|GBP|dollars?|yen)\b/i],
  [/\bhow (long|far)\b|\bduration\b|\bflight time\b|\bdistance\b/i, /\b\d+(\.\d+)?\s*(h|hr|hrs|hours?|min|mins|minutes?|km|kilomet(re|er)s?|miles?)\b/i],
  [/\bhow (tall|high)\b|\bheight\b|\belevation\b/i, /\b\d[\d,.]*\s*(m|metres?|meters?|ft|feet)\b/i],
  [/\bwhen\b|\byear\b|\bfounded\b|\bborn\b|\bbuilt\b/i, /\b(1[5-9]|20)\d{2}\b/],
  [/\bpopulation\b|\bhow many\b/i, /\b\d[\d,.]*\s*(million|billion|thousand|people|residents)?\b/i],
  [/\bweather\b|\btemperature\b/i, /°|\bdegrees?\b/i],
];

/** web pages split sentences across text runs: "… starts every night at" + "8:00 p.m. sharp" -> one line */
export function joinFragments(screen: string[]): string[] {
  const out: string[] = [];
  for (const line of screen) {
    const prev = out[out.length - 1];
    if (prev && /\b(at|is|are|was|from|of|by|to|around|about|approximately|until|costs?|takes?)$|[:–-]$/i.test(prev) && /^[\d$¥€£(]|^(HK\$|US\$)/.test(line) && line.length < 120) {
      out[out.length - 1] = `${prev} ${line}`;
    } else out.push(line);
  }
  return out;
}

export function relevantLines(screen: string[], goal: string, n = 40, head = 12): string[] {
  if (screen.length <= n) return screen;
  const g = new Set(words(goal).filter((w) => w.length > 2));
  const shapes = ANSWER_SHAPES.filter(([q]) => q.test(goal)).map(([, a]) => a);
  const scored = screen.map((line, i) => ({
    line, i,
    s: words(line).filter((w) => g.has(w)).length + (/\d{3,4}/.test(line) ? 0.5 : 0) + (shapes.some((a) => a.test(line)) ? 3 : 0),
  }));
  const pick = new Set<number>(scored.slice(0, head).map((x) => x.i));
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (pick.size >= n) break;
    if (x.s > 0) pick.add(x.i);
  }
  return scored.filter((x) => pick.has(x.i)).map((x) => x.line);
}
