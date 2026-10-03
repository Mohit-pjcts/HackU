// What the agents found, made readable for the widgets and sayable for the voice.
import type { Task } from "./contracts.ts";

/** an agent's answer for a widget: no search-result breadcrumbs, Calculator results as "45 × 12 = 540" */
export function tidyAnswer(answer: string): string {
  let s = answer.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim().replace(/^window title:\s*/i, "").replace(/^AI Overview\s*/i, "").replace(/^[\s,.;:"'“”)\]]+/, "");
  s = s.replace(/^(\S+(?: \S+)?) \1\b/, "$1"); // "Tokyo Tokyo, 17 degrees" -> "Tokyo, 17 degrees"
  s = s.replace(/https?:\/\/\S+(\s*›\s*[^\s›]+)*(\s*(\.\.\.|…))?\s*/g, "").trim(); // "https://site.net › a › b... "
  s = s.replace(/\s+([,.;:])/g, "$1");
  const calc = s.match(/^(-?[\d.,]+%?(?:\s*[×÷+\-−]\s*-?[\d.,]+%?)+)\s*=?\s+(-?[\d.,]+(?:e[+-]?\d+)?)$/);
  if (calc) s = `${calc[1]!.replace(/\s*([×÷+−]|(?<=\d)-)\s*/g, " $1 ")} = ${calc[2]}`;
  return s;
}

/** the gist of an answer, for when many agents report at once: no asides, no repeated question, one clause or two */
export function brief(answer: string): string {
  let s = tidyAnswer(answer)
    .replace(/\s*\([^)]*\)/g, "") // asides: "(various sources show 497.03, ...)"
    .replace(/^[^.?!]*\?\s+(?=\S)/, "") // a search result that starts by repeating the question
    .replace(/\b\d{1,2}:\d{2}\s*ETA\b\s*·?\s*/gi, "") // Maps: "29 min, 12:06 ETA · 35 km" -> "29 min, 35 km"
    .replace(/\s*·\s*/g, ", ")
    .replace(/,?\s*\b(Fastest|Tolls required|Hourly Forecast|People also ask)\b.*$/i, "")
    .replace(/,\s*,/g, ",");
  s = s.split(/(?<=[.!?])\s+/)[0]!;
  if (/^saved .+\.docx\b.*\bWord\b/i.test(s)) return "your Word document is ready";
  if (s.length > 60) s = s.split(/,\s+/).slice(0, 3).join(", "); // "Tokyo, 17 degrees Celsius, Partly Cloudy"
  if (s.length > 110) s = s.slice(0, 110).replace(/,[^,]*$/, "").replace(/\s+\S*$/, "");
  return s.replace(/[,;:\s]+$/, "");
}

/** the same answer, to be read out: symbols as words, at most the first two sentences */
export function sayable(answer: string): string {
  let s = tidyAnswer(answer)
    .replace(/(?:~|\/Users\/[^/\s]+)(?:\/[^/]+)*\/([^/]+?\.(?:docx|txt|rtf|pdf|md))/g, "$1") // a saved file: just its name
    .replace(/ × /g, " times ").replace(/ ÷ /g, " divided by ").replace(/ [−-] /g, " minus ").replace(/ \+ /g, " plus ").replace(/ = /g, " is ");
  const sentences = s.split(/(?<=[.!?])\s+/);
  s = sentences.slice(0, 2).join(" ");
  if (s.length > 220) s = `${s.slice(0, 217).replace(/\s+\S*$/, "")}…`;
  return s;
}

const short = (agent: string) => agent.replace(/-\d+$/, "");

/** one or two sentences to say when a run ends */
export function spokenSummary(tasks: Task[], status: string, error?: string): string {
  if (status === "error") return `Something went wrong: ${error ?? "unknown error"}`;
  if (status === "stopped") return "Stopped. The agents left everything as it is now.";
  if (!tasks.length) return "I couldn't work out which app to use for that. Try naming the app.";
  const one = tasks.length === 1;
  const many = tasks.length >= 3; // several results: each one short, or the summary takes half a minute
  const app = (name: string) => name.replace(/ Browser$/, "");
  const say = (a: string) => sayable(many ? brief(a) : a);
  const parts = tasks.map((t) => {
    if (t.status !== "done") return `${short(t.agent)} couldn't finish in ${app(t.app)}${t.exception?.reason ? `: ${say(t.exception.reason)}` : ""}`;
    const a = t.answer?.trim();
    // a writing task answers with the text it wrote: don't read the whole text back
    if (!a || (/\b(write|type|note|draft)\b/i.test(t.goal) && (t.goal.includes(a.slice(0, 40)) || a.length > 120))) return one ? `Done in ${app(t.app)}` : `${app(t.app)} is done`;
    return one ? sayable(a) : `In ${app(t.app)}: ${say(a)}`;
  });
  return parts.map((p) => (/[.!?…]$/.test(p) ? p : `${p}.`)).join(" ");
}
