// Turns a typed (or dictated) sentence into a claim. Hong Kong writes dates day/month, so 6/10 is 6 October.
// Anything ambiguous (for example "last Fri") returns null and becomes an exception: ask, don't guess.
import type { Claim } from "./contracts.ts";
import { CATEGORIES, PAYERS } from "./adapters/claims-form.ts";

const pad = (n: number) => String(n).padStart(2, "0");
export const fmtDate = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6, 星期日: 0, 星期天: 0, 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6,
  禮拜日: 0, 禮拜一: 1, 禮拜二: 2, 禮拜三: 3, 禮拜四: 4, 禮拜五: 5, 禮拜六: 6,
};

function validDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/** DD/MM/YYYY or null if absent or ambiguous */
export function parseDate(text: string, today = new Date()): string | null {
  const t = text.toLowerCase();
  // "last friday" / 上個禮拜五 / 上星期五: which one? don't guess
  if (/\blast\b|上個|上星期|上禮拜|尋日前/.test(t) && /(mon|tue|wed|thu|fri|sat|sun|星期|禮拜)/.test(t)) return null;

  let m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = validDate(y, Number(m[2]), Number(m[1]));
    return d ? fmtDate(d) : null;
  }
  m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b(?![\/\-.]\d)/); // two-part dates need / or - (a dot would read 6.50 as 6 May)
  if (m) {
    const d = validDate(today.getFullYear(), Number(m[2]), Number(m[1]));
    return d ? fmtDate(d) : null;
  }
  m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:\s+(\d{4}))?\b/);
  if (m && MONTHS[m[2]!]) {
    const d = validDate(m[3] ? Number(m[3]) : today.getFullYear(), MONTHS[m[2]!]!, Number(m[1]));
    return d ? fmtDate(d) : null;
  }
  m = t.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/);
  if (m && MONTHS[m[1]!]) {
    const d = validDate(m[3] ? Number(m[3]) : today.getFullYear(), MONTHS[m[1]!]!, Number(m[2]));
    return d ? fmtDate(d) : null;
  }
  const rel = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return fmtDate(d);
  };
  if (/\btoday\b|今日/.test(t)) return rel(0);
  if (/\btomorrow\b|\btmr\b|聽日/.test(t)) return rel(1);
  if (/\byesterday\b|尋日/.test(t)) return rel(-1);
  for (const [name, wd] of Object.entries(WEEKDAYS)) {
    const hit = /^[a-z]+$/.test(name) ? new RegExp(`\\b${name}\\b`).test(t) : t.includes(name);
    if (hit) {
      const diff = (wd - today.getDay() + 7) % 7 || 7; // the next one, never today
      return rel(diff);
    }
  }
  return null;
}

const ZH_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function zhToNumber(s: string): number | null {
  if (!/^[零〇一二兩三四五六七八九十百千]+$/.test(s)) return null;
  let total = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (ch in ZH_DIGIT) { cur = ZH_DIGIT[ch]!; seen = true; }
    else if (ch === "十") { total += (cur || 1) * 10; cur = 0; seen = true; }
    else if (ch === "百") { total += (cur || 1) * 100; cur = 0; seen = true; }
    else if (ch === "千") { total += (cur || 1) * 1000; cur = 0; seen = true; }
  }
  return seen ? total + cur : null;
}

/** "128.5", "HK$128.50", "$42", "一百二十八蚊" -> "128.50" */
export function parseAmount(text: string): string | null {
  const zh = text.match(/([零〇一二兩三四五六七八九十百千]+)\s*(?:蚊|元|塊|港元)/);
  if (zh) {
    const n = zhToNumber(zh[1]!);
    if (n !== null) return n.toFixed(2);
  }
  const marked =
    text.match(/(?:hk\$|\$|hkd\s*)\s*(\d{1,6}(?:\.\d{1,2})?)/i) ?? text.match(/(\d{1,6}(?:\.\d{1,2})?)\s*(?:dollars?|蚊|hkd)/i);
  if (marked) return Number(marked[1]).toFixed(2);
  // otherwise the first plain number that is not part of a date
  const noDates = text.replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-.]\d{2,4})?\b/g, " ").replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, " ").replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, " ");
  const plain = noDates.match(/(?<![\d.])(\d{1,6}(?:\.\d{1,2})?)(?![\d])/);
  return plain ? Number(plain[1]).toFixed(2) : null;
}

const CATEGORY_WORDS: Record<string, string[]> = {
  Food: ["food", "tea", "snack", "lunch", "dinner", "cake", "drink", "catering", "餐", "食", "茶"],
  Transport: ["transport", "taxi", "mtr", "bus", "uber", "交通", "車", "的士"],
  Printing: ["print", "printing", "poster", "photocopy", "印"],
  Venue: ["venue", "room", "hall", "booking", "場", "租"],
};
export function parseCategory(text: string): string | null {
  const t = text.toLowerCase();
  for (const c of CATEGORIES) if (t.includes(c.toLowerCase())) return c;
  for (const [c, words] of Object.entries(CATEGORY_WORDS)) if (words.some((w) => t.includes(w))) return c;
  return null;
}

export function parsePaidBy(text: string): string {
  const t = text.toLowerCase();
  if (/\bfps\b|轉數快/.test(t)) return "FPS";
  if (/\bcash\b|現金/.test(t)) return "Cash";
  return PAYERS[1]!; // FPS by default, shown on the claim card so the user can correct it
}

export interface Parsed {
  claim?: Claim;
  /** why no claim could be built */
  problem?: { code: "unparseable_date" | "missing_field"; reason: string };
  partial: Partial<Claim>;
}

/** "Chan Tai Man, food, 128.50, 30/09/2026, FPS" (commas optional) */
export function parseClaim(text: string, today = new Date()): Parsed {
  const parts = text.split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
  let payee = "";
  if (parts.length > 1) payee = parts[0]!;
  else payee = text.split(/\s+(?=\$|hk\$|\d)/i)[0]!.replace(/\b(food|tea|taxi|transport|printing|venue)\b.*/i, "").trim();
  payee = payee.replace(/^(add|claim|new claim|加)\s+/i, "").trim();

  const date = parseDate(text, today);
  const amount = parseAmount(text);
  const category = parseCategory(text);
  const paidBy = parsePaidBy(text);
  const partial: Partial<Claim> = {};
  if (payee) partial.payee = payee;
  if (amount) partial.amount = amount;
  if (date) partial.date = date;
  if (category) partial.category = category;
  partial.paidBy = paidBy;

  if (!payee) return { partial, problem: { code: "missing_field", reason: "no payee name found" } };
  if (!amount) return { partial, problem: { code: "missing_field", reason: "no amount found" } };
  if (!category) return { partial, problem: { code: "missing_field", reason: `no category found (use one of ${CATEGORIES.join(", ")})` } };
  if (!date) return { partial, problem: { code: "unparseable_date", reason: `could not read a single date from "${text}" (ambiguous or missing)` } };
  return { partial, claim: { payee, amount, date, category, paidBy } };
}
