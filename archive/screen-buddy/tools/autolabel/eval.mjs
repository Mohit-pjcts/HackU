// Headless batch run of the Brain Lab (tools/brain-lab.html) on a labelled set,
// e.g. the output of autolabel.mjs. Writes results.json, results.csv and summary.md.
//
// The model calls go through the normal /api/step endpoint of the server at --base,
// with all its validation and limits. For a long run, start the dev server with a
// higher RATE_LIMIT_PER_MINUTE in .env; the lab also waits and retries on 429.
//
// Usage:
//   npm run dev                      (in the repo root, with the API key in .env)
//   node eval.mjs --dir out --split tune --modes direct,grid,refine [--base http://localhost:3000] [--model claude-opus-5-5]
//                 [--conc 2] [--first-pass grid] [--no-hints] [--negatives 2] [--code ACCESS_CODE]

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launch } from "./harness.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg("base", "http://localhost:3000").replace(/\/$/, "");
const dir = resolve(arg("dir", "out"));
const split = arg("split", "all");
const modes = arg("modes", "direct,grid,refine").split(",");
const conc = arg("conc", "1");
const model = arg("model", "");
const code = arg("code", process.env.JUDGE_ACCESS_CODE || "");
const firstPass = arg("first-pass", "direct");
const noHints = process.argv.includes("--no-hints");
const outPrefix = arg("prefix", `eval-${split}-${model || "default"}${noHints ? "-nohints" : ""}`);

const labels = JSON.parse(await readFile(join(dir, "labels.json"), "utf8"));
const wanted = new Set(labels.items.filter((i) => split === "all" || i.split === split).map((i) => i.file));
const files = (await readdir(dir)).filter((f) => wanted.has(f)).map((f) => join(dir, f));
console.log(`${wanted.size} screenshots, ${labels.items.filter((i) => wanted.has(i.file)).length} labelled targets, modes ${modes.join(",")}, against ${base}`);

const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)/.test(base);
const browser = await launch({ useProxy: !isLocal });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`${base}/tools/brain-lab.html`);
  await page.waitForFunction(() => window.brainLab && document.querySelector("#model option"));
  await page.setInputFiles("#files", [join(dir, "labels.json"), ...files]);
  await page.waitForFunction((n) => window.brainLab.state.images.size >= n, files.length, { timeout: 120_000 });
  await page.evaluate(({ modes, split, conc, model, code, firstPass, noHints }) => {
    document.querySelectorAll(".mode").forEach((el) => { el.checked = modes.includes(el.value); });
    document.getElementById("batchSplit").value = split;
    document.getElementById("conc").value = conc;
    document.getElementById("firstPass").value = firstPass;
    document.getElementById("sendHint").checked = !noHints;
    if (model) document.getElementById("model").value = model;
    document.getElementById("code").value = code;
  }, { modes, split, conc, model, code, firstPass, noHints });
  // Two screens with nothing to point at: the buddy should say "I can't tell" on both.
  const negatives = Number(arg("negatives", "2"));
  for (let k = 0; k < negatives; k += 1) await page.evaluate((kind) => window.brainLab.addSynthetic(kind), k % 2 ? "unrelated" : "blank");
  if (model && (await page.$eval("#model", (s) => s.value)) !== model) {
    throw new Error(`Model ${model} is not in the server's ALLOWED_MODELS`);
  }

  const timer = setInterval(async () => {
    const s = await page.$eval("#status", (e) => e.textContent).catch(() => "");
    if (s) console.log(s);
  }, 15_000);
  await page.evaluate(() => window.brainLab.runBatch());
  clearInterval(timer);
  console.log(await page.$eval("#status", (e) => e.textContent));

  const rows = await page.evaluate(() => window.brainLab.resultRows());
  const summary = await page.evaluate(() => {
    const table = (id) => Array.from(document.querySelectorAll(`#${id} tr`)).map((tr) => Array.from(tr.children).map((c) => c.textContent.trim()));
    return { sum: table("sumTable"), sweep: table("sweepTable"), neg: table("negTable") };
  });
  const md = (t) => (t.length ? [`| ${t[0].join(" | ")} |`, `|${t[0].map(() => "---").join("|")}|`, ...t.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n") : "");
  const info = await page.$eval("#srv", (e) => e.textContent);
  const report = `# Pointing evaluation (${new Date().toISOString()})

Server: ${base} (${info}). Split: ${split}. Modes: ${modes.join(", ")}. Refine first pass: ${firstPass}. Hints sent: ${!noHints}.
Labelled set: ${dir} (${rows.length} answers).

${md(summary.sum)}

Confidence floor sweep (coverage / precision):

${md(summary.sweep)}

Screens with nothing to point at (blank / unrelated; correct answer is "I can't tell"):

${md(summary.neg)}
`;
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  await writeFile(join(dir, `${outPrefix}.json`), JSON.stringify({ base, split, modes, rows }, null, 2));
  await writeFile(join(dir, `${outPrefix}.csv`), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
  await writeFile(join(dir, `${outPrefix}.md`), report);
  console.log(`\n${report}\nWrote ${outPrefix}.json/.csv/.md in ${dir}`);
} finally {
  await browser.close();
}
