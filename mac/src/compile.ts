// Plan compilers: turn common goals into exact steps IN CODE (no LLM, no cost, no latency).
// "Code computes facts; the classifier only chooses" (the awlevin principle). Anything not covered returns null,
// and the agent falls back to a cached plan, then (optionally) to an LLM planner, then to jev on its own.
import type { Item, PlanStep } from "./contracts.ts";

// ---------- shared text helpers ----------

/** "titled 'Groceries' with milk, eggs and bread" -> "Groceries\n• milk\n• eggs\n• bread" (no LLM needed) */
export function titledList(goal: string): string | null {
  const m = goal.match(/\b(?:titled|called|named|headed)\s*["“'‘]([^"”'’]+)["”'’]\s*(?:with|containing|listing|that lists|including)\s+(?:the\s+(?:items?|things?)\s+)?(.+?)\s*\.?$/i);
  if (!m) return null;
  const items = m[2]!.split(/,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.some((s) => s.split(/\s+/).length > 8)) return null; // a description, not a list: leave it
  return `${m[1]!.trim()}\n${items.map((s) => `• ${s}`).join("\n")}`;
}

/** text the user put in quotes, or after "saying" / "that says" / "the text" */
export function explicitText(goal: string): string | null {
  const listed = titledList(goal);
  if (listed) return listed;
  const q = goal.match(/["“'‘]([^"”'’]{2,})["”'’]/);
  if (q) return q[1]!.trim();
  const s = goal.match(/\b(?:saying|that says|which says|with the text|the words)\s*:?\s+(.+?)\s*(?:\.$|$|\bin (?:textedit|notes)\b)/i);
  return s ? s[1]!.trim() : null;
}

/** the concrete values a goal gives: quoted text, names (capitalised words that aren't the first word or the app it
 *  is told to use), and the TARGETS among them: what a verb of reaching asks to get to ("message Sohan", "reply to
 *  Sohan's text", "open the chat with Mum"). "Open WhatsApp, message Sohan "hi"" -> quoted ["hi"], names ["Sohan"],
 *  targets ["Sohan"]. */
export function goalValues(goal: string): { quoted: string[]; names: string[]; targets: string[] } {
  const QUOTE = /["“]([^"”]{1,300})["”]|(?<=^|[\s:(,])['‘]([^'’]{2,300})['’](?=$|[\s,.!?:;)])/g;
  const quoted = [...goal.matchAll(QUOTE)].map((q) => (q[1] ?? q[2])!.trim()).filter(Boolean);
  const rest = goal.replace(QUOTE, " , ");
  const names: string[] = [];
  for (const m of rest.matchAll(/\b([A-Z][\p{L}\p{N}'’&-]*(?:\s+[A-Z][\p{L}\p{N}'’&-]*){0,2})/gu)) {
    const before = rest.slice(0, m.index).trimEnd();
    if (!before || /[.!?:;]$/.test(before)) continue; // the first word of a sentence
    if (/\b(open|in|on|using|via|launch|start|use)$/i.test(before)) continue; // the app to use ("open WhatsApp", "in Discord")
    const n = m[1]!.replace(/[’']s$/, "");
    if (!names.includes(n) && !quoted.some((q) => q.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  const REACH = /\b(?:message|text|dm|email|call|ring|reply(?:ing)? to|respond(?:ing)? to|answer|chat with|write to|talk to|open|go to|switch to|select|join)\s+(?:the\s+)?(?:(?:chat|conversation|thread|group)\s+(?:with\s+|called\s+|named\s+)?)?(?:(?:last|latest|newest|most recent)\s+)?(?:(?:message|text)\s+from\s+)?["“'‘]?$/i;
  // phone numbers are names too ("message +852 9123 4567")
  for (const m of rest.matchAll(/\+?\d[\d ()-]{6,}\d/g)) if (!names.includes(m[0].trim())) names.push(m[0].trim());
  const targets = [...quoted, ...names].filter((v) => {
    const at = goal.indexOf(v);
    return at > 0 && REACH.test(goal.slice(0, at));
  });
  return { quoted, names, targets };
}

/** a field for what to SAY (a message, a reply), and a field for WHO or WHAT to find (search, recipient, name) */
export const MESSAGE_FIELD = /\b(message|compose|reply|imessage|write a|type a|say something|chat)\b/i;
export const FIND_FIELD = /\b(search|find|name|number|username|recipient|to:|contact)\b/i;
/** the goal asks to SEND something: only then may a message field be filled and Enter / Send pressed in it */
export const SEND_INTENT = /\b(send|message|text|reply|respond|tell|say|post|dm|answer|write to)\b/i;

export const asksQuestion = (goal: string): boolean =>
  mustCompute(goal) ||
  /\b(tell me|what|when|which|who|where|how (many|much|long|tall|old|far)|find out|look up|compute|calculate|work out|report)\b/i.test(goal) ||
  /\bcheck\b(?!\s+(?:the\s+|a\s+|that\s+)?(?:check)?box)/i.test(goal) || // "check the weather in Tokyo", "check Sony's stock price"
  /\bfind\s+(?:the|a|an|out|how|what|when|who|which)\b(?!.*\b(file|folder|document)s?\b)/i.test(goal);
/** the goal is ONLY to open pages: nothing to answer, play, write or click after opening (then counting tabs is the check) */
export const openOnly = (goal: string): boolean =>
  /\b(open|go to|visit|launch|bring up|pull up)\b/i.test(goal) && !asksQuestion(goal) &&
  !/\b(play|watch|click|press|write|type|search|send|sign|log ?in|download|buy|add|reply|post|fill|book|subscribe|like|scroll|read)\b/i.test(goal);
/** the answer must be produced by doing something (not just read off what was already on screen) */
export const mustCompute = (goal: string) =>
  /\b(compute|calculate|work out|add|plus|subtract|minus|times|multiply|multiplied|divide|divided|sum|total|convert|square|squared)\b/i.test(goal) && /\d/.test(goal);

// ---------- Calculator ----------

const OPS: [RegExp, string][] = [
  [/^(times|x|×|\*|multiplied by)$/i, "Multiply"],
  [/^(plus|\+|add)$/i, "Add"],
  [/^(minus|-|−|subtract)$/i, "Subtract"],
  [/^(divided by|over|÷|\/)$/i, "Divide"],
];

/** "128 times 37", "45 × 12", "1200 / 3", "15% of 2480" -> button presses */
export function calculatorPlan(goal: string, items: Item[]): PlanStep[] | null {
  const labels = new Set(items.map((i) => i.text));
  const clear = labels.has("All Clear") ? "All Clear" : labels.has("Clear") ? "Clear" : null;
  const digitsOf = (n: string): string[] => [...n].map((ch) => (ch === "." ? "Point" : ch));
  const press = (keys: string[]) => keys.map((k) => ({ action: "click" as const, target: k }));
  const g = goal.replace(/,(?=\d{3})/g, "");
  let m = g.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)/i);
  if (m) {
    // p% of n  =  n × p ÷ 100
    const keys = [...digitsOf(m[2]!), "Multiply", ...digitsOf(m[1]!), "Divide", "1", "0", "0", "Equals"];
    return press([...(clear ? [clear] : []), ...keys]);
  }
  m = g.match(/\bsquare of\s+(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s+squared\b/i);
  if (m) {
    const n = m[1] ?? m[2]!;
    const keys = [...digitsOf(n), "Multiply", ...digitsOf(n), "Equals"];
    if (keys.every((k) => labels.has(k))) return press([...(clear ? [clear] : []), ...keys]);
  }
  m = g.match(/(\d+(?:\.\d+)?)\s*(times|x|×|\*|multiplied by|plus|\+|minus|−|-|divided by|over|÷|\/)\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const op = OPS.find(([re]) => re.test(m![2]!.trim()))?.[1];
  if (!op) return null;
  const keys = [...digitsOf(m[1]!), op, ...digitsOf(m[3]!), "Equals"];
  if (keys.some((k) => !labels.has(k))) return null; // the window doesn't show these buttons: don't guess
  return press([...(clear ? [clear] : []), ...keys]);
}

// ---------- the web ----------

const APP_WORDS = /\b(?:in|on|using|with|open)\s+(?:a\s+new\s+)?(?:safari|chrome|google chrome|brave|brave browser|the browser|my browser)(?:\s+(?:window|tab))?\b/gi;

/** well-known sites people name instead of typing a URL */
export const KNOWN_SITES: [RegExp, string][] = [
  [/\bclaude\b.*\b(dash\w*|console|api|platform|usage|billing)\b|\b(anthropic)\s+(console|dash\w*)\b/i, "https://platform.claude.com"],
  [/\bclaude\b/i, "https://claude.ai"],
  [/\btype ?safe\b/i, "https://console.typesafe.ai"],
  [/\byoutube\b/i, "https://www.youtube.com"],
  [/\bgmail\b/i, "https://mail.google.com"],
  [/\bgithub\b/i, "https://github.com"],
  [/\bwhatsapp\b/i, "https://web.whatsapp.com"],
  [/\bmoodle\b/i, "https://moodle.hku.hk"],
  [/\bchatgpt\b/i, "https://chatgpt.com"],
  [/\bgoogle (docs?)\b/i, "https://docs.google.com"],
  [/\bgoogle drive\b/i, "https://drive.google.com"],
  [/\bcanvas\b/i, "https://canvas.instructure.com"],
];

/** "open the Claude dashboard and the TypeSafe dashboard (in a new window)" -> the sites' URLs, opened together */
export function openSitesPlan(goal: string): PlanStep[] | null {
  if (!/\b(open|go to|visit|launch|bring up|pull up)\b/i.test(goal)) return null;
  if (/\b(search|look up|find|tell me|play)\b/i.test(goal)) return null;
  const parts = goal.replace(APP_WORDS, " ").split(/,|\band\b|&|\bplus\b/i);
  const urls: string[] = [];
  for (const part of parts) {
    const hit = KNOWN_SITES.find(([re]) => re.test(part));
    if (hit && !urls.includes(hit[1])) urls.push(hit[1]);
  }
  if (!urls.length) return null;
  const newWindow = /\bnew\s+(?:\w+\s+){0,2}window\b/i.test(goal);
  return [{ action: "open_url", text: urls.join(" "), target: newWindow ? "new window" : undefined }];
}

/** a URL that already encodes the search: no search box, no pop-up suggestions */
export function webPlan(goal: string): PlanStep[] | null {
  const sites = openSitesPlan(goal);
  if (sites) return sites;
  const g = goal.replace(APP_WORDS, " ").replace(/\s+/g, " ").trim();
  const site = g.match(/\b(?:open|go to|visit)\s+((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i);
  if (site && !/\b(search|look up|find|tell me)\b/i.test(g)) return [{ action: "open_url", text: site[1]!.startsWith("http") ? site[1]! : `https://${site[1]}` }];
  if (/\byoutube\b/i.test(g) && !/\bsearch\b/i.test(g)) return [{ action: "open_url", text: "https://www.youtube.com" }];
  if (!asksQuestion(g) && !/\b(search|find)\b/i.test(g)) return null;
  if (/\bwikipedia\b/i.test(g)) {
    // the thing to look up: "look up X on Wikipedia and tell me ..." -> X
    const what = g
      .replace(/^.*?\b(?:look up|search(?: for)?|find|open)\s+/i, "")
      .replace(/\s+on wikipedia\b.*$/i, "")
      .replace(/\s+and\s+(?:tell|find|report|give).*$/i, "")
      .replace(/^(?:the\s+)?(?:wikipedia\s+(?:article|page)\s+(?:for|on|about)\s+)/i, "")
      .trim();
    if (what) return [{ action: "open_url", text: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(what)}` }];
  }
  // otherwise a web search with the whole information need: search engines handle natural language well
  const q = g.replace(/^(?:please\s+)?(?:look up|search(?: for)?|find(?: out)?|tell me|check)\s+/i, "").replace(/[.?!]+$/, "");
  return [{ action: "open_url", text: `https://www.google.com/search?q=${encodeURIComponent(q)}` }];
}

// ---------- writing explicit text ----------

/** "make a word doc", "as a Word document", "save it as docx" */
export const WORD_DOC = /\b(word\s+(doc|docs|document|file)s?|docx|\.doc\b|ms\s+word|microsoft\s+word)\b/i;

export function writePlan(goal: string, items: Item[]): PlanStep[] | null {
  if (WORD_DOC.test(goal)) {
    // write the text (given, or by the writer), then code saves it as a real .docx and opens it in Word
    const field = items.find((i) => i.role === "AXTextArea" && i.state === "empty") ?? items.find((i) => i.role === "AXTextArea");
    return [{ action: "type", target: field?.text, text: explicitText(goal) ?? undefined }, { action: "save_as", text: "docx", target: "Microsoft Word" }];
  }
  // a quoted TITLE is not the whole content ("a note titled 'X' with ..."): don't compile, let the planner handle it
  if (/\b(titled|called|named|headed)\s*["“'‘]/i.test(goal) && !titledList(goal)) return null;
  const text = explicitText(goal);
  if (!text) return null;
  const field = items.find((i) => i.role === "AXTextArea" && i.state === "empty") ?? items.find((i) => i.role === "AXTextArea");
  return [{ action: "type", target: field?.text, text }];
}

// ---------- Finder ----------

const TYPE_FOLDERS: [string, RegExp][] = [
  ["Documents", /\.(pdf|docx?|rtf|pages|odt|md|key|pptx?)$/i],
  ["Images", /\.(png|jpe?g|gif|heic|webp|tiff?|bmp|svg)$/i],
  ["Spreadsheets", /\.(csv|xlsx?|numbers|ods|tsv)$/i],
  ["Text", /\.(txt|log)$/i],
  ["Audio", /\.(mp3|m4a|wav|aac|flac)$/i],
  ["Video", /\.(mp4|mov|m4v|avi|mkv)$/i],
  ["Archives", /\.(zip|rar|7z|tar|gz|dmg)$/i],
  ["Code", /\.(js|ts|py|java|c|cpp|swift|go|rs|html|css|json|sh)$/i],
];

/** "by type" -> the type folders actually needed; "into A, B and C" -> those names */
export function finderPlan(goal: string, files: string[]): PlanStep[] | null {
  if (!/\b(organi[sz]e|sort|tidy|clean up|arrange)\b/i.test(goal)) return null;
  const named = goal.match(/\binto\s+(?:(?:three|four|five|two|\d+)\s+)?folders?\s*(?:called|named|:)?\s*(.+?)\s*$/i) ?? goal.match(/\binto\s+(.+?)\s+folders?\b/i);
  if (named && !/\bby (type|kind|extension)\b/i.test(goal)) {
    const names = named[1]!.replace(/[.]$/, "").split(/,\s*|\s+and\s+/).map((s) => s.replace(/^(?:a|the)\s+/i, "").trim()).filter((s) => s && s.length < 40);
    if (names.length >= 2) return [{ action: "sort_into", text: names.join(", ") }];
  }
  const needed = TYPE_FOLDERS.filter(([, re]) => files.some((f) => re.test(f))).map(([n]) => n);
  if (!needed.length) return null;
  return [{ action: "sort_into", text: needed.join(", ") }];
}

/** pick a compiler by app */
// ---------- apps that open straight to the answer from a link ----------

/** "how long to drive from HKU to the airport" -> Apple Maps with the route already planned (maps:// link) */
export function mapsPlan(goal: string): PlanStep[] | null {
  const g = goal.replace(/\b(?:in|on|using|with)\s+(?:apple\s+)?maps\b/gi, " ").replace(/\s+/g, " ").trim();
  const m = g.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:by|on|via)\s+(car|driving|transit|public transport|bus|mtr|train|walking|foot))?(?:[,.?!]|$|\s+and\b)/i)
    ?? g.match(/\b(?:directions|route|way|drive|walk)\s+to\s+(.+?)(?:[,.?!]|$|\s+and\b)/i);
  if (!m) return null;
  const [from, to] = m.length >= 3 && m[2] ? [m[1]!, m[2]!] : ["", m[1]!];
  const how = /\b(transit|public transport|bus|mtr|train)\b/i.test(g) ? "r" : /\b(walk|walking|on foot)\b/i.test(g) ? "w" : "d";
  const clean = (s: string) => s.replace(/^(?:the\s+)/i, "").trim();
  return [{ action: "open_url", text: `maps://?${from ? `saddr=${encodeURIComponent(clean(from))}&` : ""}daddr=${encodeURIComponent(clean(to))}&dirflg=${how}` }];
}

const TICKERS: [RegExp, string][] = [
  [/\bapple\b/i, "AAPL"], [/\bnvidia\b/i, "NVDA"], [/\btesla\b/i, "TSLA"], [/\bmicrosoft\b/i, "MSFT"], [/\b(google|alphabet)\b/i, "GOOGL"],
  [/\bamazon\b/i, "AMZN"], [/\b(meta|facebook)\b/i, "META"], [/\bnetflix\b/i, "NFLX"], [/\btencent\b/i, "0700.HK"], [/\balibaba\b/i, "BABA"],
  [/\bhsbc\b/i, "0005.HK"], [/\bsony\b/i, "SONY"], [/\btoyota\b/i, "TM"], [/\bbitcoin\b/i, "BTC-USD"], [/\b(s&p|s and p)\s*500\b/i, "^GSPC"], [/\bhang seng\b/i, "^HSI"],
];

/** "what's Apple's stock price" -> the Stocks app opened on AAPL (stocks:// link) */
export function stocksPlan(goal: string): PlanStep[] | null {
  const known = TICKERS.find(([re]) => re.test(goal));
  const explicit = (goal.match(/\b[A-Z]{2,5}(?:\.[A-Z]{1,2})?\b/g) ?? []).find((t) => !/^(HKU|USD|HKD|MTR|AI|OK|US|UK|HK|ETA)$/.test(t));
  const symbol = known?.[1] ?? explicit;
  return symbol ? [{ action: "open_url", text: `stocks://?symbol=${encodeURIComponent(symbol)}` }] : null;
}

/** "check the weather in Hong Kong" -> switch the Weather app to that city (done in code: search, pick the city) */
export function weatherPlan(goal: string): PlanStep[] | null {
  const m = goal.match(/\b(?:weather|forecast|temperature)\b.*?\b(?:in|for|at)\s+([A-Za-z][A-Za-z .'-]*?)(?:\s+(?:today|tonight|tomorrow|now|right now|this week|this weekend))?\s*[.?!]*$/i);
  return m ? [{ action: "pick_city", text: m[1]!.trim() }] : null;
}

export function compilePlan(app: string, goal: string, items: Item[], files: string[] = []): PlanStep[] | null {
  if (app === "Calculator") return calculatorPlan(goal, items);
  if (app === "Maps") return mapsPlan(goal);
  if (app === "Stocks") return stocksPlan(goal);
  if (app === "Weather") return weatherPlan(goal);
  if (app === "Finder") return finderPlan(goal, files);
  if (["Safari", "Google Chrome", "Brave Browser", "Arc", "Firefox"].includes(app)) return webPlan(goal);
  if (["TextEdit", "Notes"].includes(app)) return writePlan(goal, items);
  return null;
}
