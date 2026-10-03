import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchApp } from "../src/apps.ts";
import type { Brain, Decision, Facts, Helper, Item, PlanStep, Task } from "../src/contracts.ts";
import { RunLogger } from "../src/logger.ts";
import { runTask } from "../src/loop.ts";
import { planWithoutLlm, totalsOf } from "../src/manager.ts";
import { perceive, relevantLines, screenFromMarkdown, windowElements } from "../src/perceive.ts";
import { SimCalc } from "./sim-calc.ts";

const newTask = (goal: string): Task => ({
  id: "t1", agent: "Mint-3", app: "Calculator", goal, brain: "jev", status: "queued", steps: 0, seconds: 0,
  cost: { decisionsUsd: 0, helperUsd: 0 }, counts: { decisions: 0, actions: 0, helperCalls: 0, gated: 0, foreground: 0, scripted: 0 }, decideMs: [], llmCalls: [],
});

/** follows the plan like a perfectly grounded classifier would (or returns a fixed low confidence) */
class PlanFollower implements Brain {
  readonly kind = "jev" as const;
  readonly model = "replay";
  constructor(private conf = 0.95) {}
  async classify(f: Facts, items: Item[]): Promise<Decision> {
    const st = f.plan?.[f.planPos ?? 0];
    const it = st ? items.find((i) => i.text === st.target) : undefined;
    return {
      kind: st ? "click" : "done", item: it?.i, kindConf: this.conf, itemConf: this.conf, gate: this.conf, backend: "jev",
      model: "replay", inputTokens: 1000, outputTokens: 0, costUsd: 1000 * 0.042e-6, ms: 1,
    };
  }
}

class StubHelper implements Helper {
  verifies = 0;
  constructor(private expected: string, private steps: PlanStep[]) {}
  async plan() { return { steps: this.steps, costUsd: 0.001, ms: 1 }; }
  async writeText() { return { text: "", costUsd: 0, ms: 1 }; }
  async verify(_g: string, screen: string[]) {
    this.verifies++;
    const ok = screen.includes(this.expected);
    return { achieved: ok, answer: ok ? this.expected : "", reason: ok ? "shown" : `display shows ${screen.join(",")}`, costUsd: 0.001, ms: 1 };
  }
}

const clicks = (...labels: string[]): PlanStep[] => labels.map((target) => ({ action: "click", target }));
const ctx = (driver: SimCalc, brain: Brain, helper: Helper) => ({
  runId: "test", driver, brain, helper, signal: new AbortController().signal, win: driver.win, sleep: async () => {},
  log: new RunLogger("t-" + Math.random().toString(36).slice(2), mkdtempSync(join(tmpdir(), "runs-"))),
});

test("perception reads only the app window (never the menu bar) and finds display text in the markdown", async () => {
  const d = new SimCalc();
  d.display = "42";
  const obs = await d.observe("Mint-3", d.win);
  expect(windowElements(obs).some((e) => e.label === "Quit")).toBe(false);
  const p = perceive(obs, "compute 6 times 7");
  expect(p.items.map((i) => i.text)).toContain("Multiply");
  expect(p.items.map((i) => i.text)).not.toContain("Quit");
  expect(p.screen).toEqual(["window title: Calculator", "42"]); // bidi mark stripped, menu bar text skipped, title added
});

test("screen text from Cua's markdown", () => {
  const md = `- [0] AXWindow "Doc"\n  - AXStaticText = "Hello"\n  - [1] AXTextField (Search) = "query"\n  - AXHeading (Title)\n  - [2] AXButton (OK)`;
  expect(screenFromMarkdown(md)).toEqual(["Hello", "query", "Title"]);
});

test("relevant lines keep the head plus lines sharing words with the goal", () => {
  const screen = Array.from({ length: 100 }, (_, i) => `filler line ${i}`);
  screen[80] = "The university was founded in 1911";
  const r = relevantLines(screen, "when was the university founded", 20, 5);
  expect(r).toContain("The university was founded in 1911");
  expect(r.length).toBeLessThanOrEqual(20);
});

test("a planned task runs to a verified answer", async () => {
  const d = new SimCalc();
  const helper = new StubHelper("42", clicks("All Clear", "6", "Multiply", "7", "Equals"));
  const task = await runTask(ctx(d, new PlanFollower(), helper), newTask("compute 6 times 7"));
  expect(task.status).toBe("done");
  expect(task.answer).toBe("42");
  expect(d.calls).toEqual(["All Clear", "6", "Multiply", "7", "Equals"]);
  expect(task.counts.decisions).toBe(5); // finished plan -> straight to the check, no extra classifier call
});

test("low confidence stops BEFORE touching the app (escalate rather than guess)", async () => {
  const d = new SimCalc();
  const task = await runTask(ctx(d, new PlanFollower(0.2), new StubHelper("42", clicks("6"))), newTask("compute 6 times 7"));
  expect(task.status).toBe("failed");
  expect(task.exception?.code).toBe("low_confidence");
  expect(d.calls).toEqual([]);
});

test("a wrong result is never reported as done (the verifier reads the screen)", async () => {
  const d = new SimCalc();
  // a bad plan: computes 6 x 8
  const task = await runTask(ctx(d, new PlanFollower(), new StubHelper("42", clicks("All Clear", "6", "Multiply", "8", "Equals"))), newTask("compute 6 times 7"));
  expect(task.status).toBe("failed");
  expect(task.exception?.code).toBe("not_achieved");
});

test("actions that keep failing end the task with the driver's reason", async () => {
  const d = new SimCalc();
  d.failClicks = true;
  const task = await runTask(ctx(d, new PlanFollower(), new StubHelper("42", clicks("6", "Multiply", "7", "Equals"))), newTask("compute 6 times 7"));
  expect(task.status).toBe("failed");
  expect(["driver_refused", "stalled"]).toContain(task.exception!.code);
});

test("planning without an LLM key: 'App: goal' and 'in App' forms", () => {
  const apps = ["Calculator", "TextEdit", "Safari"];
  expect(planWithoutLlm("Calculator: compute 6x7; TextEdit: write hello", apps)).toEqual([
    { app: "Calculator", goal: "compute 6x7" },
    { app: "TextEdit", goal: "write hello" },
  ]);
  expect(planWithoutLlm("compute 6x7 in Calculator", apps)).toEqual([{ app: "Calculator", goal: "compute 6x7 in Calculator" }]);
});

test("app names are matched forgivingly", () => {
  const apps = [{ name: "Calculator", bundle_id: "a", running: true }, { name: "TextEdit", bundle_id: "b", running: false }];
  expect(matchApp(apps, "calculator")?.name).toBe("Calculator");
  expect(matchApp(apps, "Calc")?.name).toBe("Calculator");
  expect(matchApp(apps, "textedit.app")?.name).toBe("TextEdit");
  expect(matchApp(apps, "Photoshop")).toBeNull();
});

test("totals: median decision time and costs", () => {
  const t = newTask("x");
  t.status = "done"; t.decideMs = [500, 700, 600]; t.cost = { decisionsUsd: 0.0001, helperUsd: 0.002 }; t.counts.decisions = 3;
  const tot = totalsOf([t], 10);
  expect(tot.medianDecideMs).toBe(600);
  expect(tot.done).toBe(1);
  expect(tot.decisionsUsd).toBeCloseTo(0.0001);
});

test("safety: never types into a text area that already holds someone else's text", async () => {
  const { runTask } = await import("../src/loop.ts");
  const d = new SimCalc();
  // turn the sim into a one-field app whose text area already holds the user's note
  d.observe = async (agent, w) => ({
    agent, window: w, truncated: false, ms: 1,
    elements: [
      { index: 0, depth: 0, role: "AXWindow", label: "Notes", actions: [] },
      { index: 1, parent: 0, depth: 1, role: "AXTextArea", label: "My private note", value: "My private note", token: "tok-area", actions: [] },
    ],
  });
  let typed = false;
  d.typeText = async () => { typed = true; return { ok: true, channel: "ax", ms: 1, cli: "sim" }; };
  class TypeHere implements Brain {
    readonly kind = "jev" as const; readonly model = "x";
    async classify(_f: Facts, items: Item[]): Promise<Decision> {
      return { kind: "type_text", item: items[0]!.i, text: "Japan itinerary", kindConf: 1, itemConf: 1, gate: 1, backend: "jev", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 };
    }
  }
  const task = await runTask(ctx(d, new TypeHere(), new StubHelper("x", [{ action: "type", text: "Japan itinerary" }])), newTask("write a Japan itinerary in Notes"));
  expect(typed).toBe(false);
  expect(task.status).toBe("failed");
});

test("the agent may keep typing into a note it created itself (own text is not 'someone else's')", async () => {
  const { runTask } = await import("../src/loop.ts");
  const d = new SimCalc();
  let value = "";
  d.observe = async (agent, w) => ({
    agent, window: w, truncated: false, ms: 1,
    elements: [
      { index: 0, depth: 0, role: "AXWindow", label: "Notes", actions: [] },
      { index: 1, parent: 0, depth: 1, role: "AXTextArea", label: value || "Note Body Text View", value: value || undefined, token: "tok", actions: [] },
    ],
  });
  const typed: string[] = [];
  (d as any).typeText = async (_h: string, _w: unknown, _t: string, text: string) => { typed.push(text); value += text; return { ok: true, channel: "ax", ms: 1, cli: "sim" }; };
  class TypeTwice implements Brain {
    readonly kind = "jev" as const; readonly model = "x"; n = 0;
    async classify(f: Facts, items: Item[]): Promise<Decision> {
      return { kind: "type_text", item: items[0]!.i, kindConf: 1, itemConf: 1, gate: 1, backend: "jev", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 };
    }
  }
  const helper = new StubHelper("Title Item one", [{ action: "type", text: "Title\n" }, { action: "type", text: "Item one" }]);
  const task = await runTask(ctx(d, new TypeTwice(), helper), newTask("write a note with a title and one item"));
  expect(typed).toEqual(["Title\n", "Item one"]); // the second type was NOT blocked as someone else's text
  expect(task.status).toBe("done");
});

test("Finder folder: the path bar's selected item is cut off; the sandbox rules hold", async () => {
  const { finderFolder, safeRoot, FileOps } = await import("../src/fsops.ts");
  const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const root = mkdtempSync(join(homedir(), ".agents-test-")); // inside home, but hidden -> must be refused by safeRoot
  expect(safeRoot(root)).not.toBeNull();
  expect(safeRoot(homedir())).not.toBeNull();
  const parts = root.split("/").filter(Boolean);
  const obs: any = {
    window: { pid: 1, windowId: 1, app: "Finder", title: parts[parts.length - 1] },
    elements: [
      { index: 0, depth: 0, role: "AXList", label: "path", actions: [] },
      ...["Macintosh HD", ...parts, "selected.pdf"].map((v, k) => ({ index: k + 1, parent: 0, depth: 1, role: "AXStaticText", label: v, value: v, actions: [] })),
    ],
  };
  expect(finderFolder(obs)).toBe(root);
  writeFileSync(join(root, "a.pdf"), "x");
  const ops = new FileOps(root, join(root, "undo"), "t1");
  expect(ops.makeFolder("../escape").ok).toBe(false);
  expect(ops.makeFolder("PDFs").ok).toBe(true);
  expect(ops.moveFile("a.pdf", "PDFs").ok).toBe(true);
  expect(existsSync(join(root, "PDFs", "a.pdf"))).toBe(true);
  writeFileSync(join(root, "a.pdf"), "y");
  expect(ops.moveFile("a.pdf", "PDFs").ok).toBe(false); // never overwrites
  expect(readFileSync(ops.undoFile, "utf8")).toContain("mv ");
});

test("compilers: calculator, web, writing, finder (and they refuse what they don't understand)", async () => {
  const { calculatorPlan, webPlan, writePlan, finderPlan } = await import("../src/compile.ts");
  const calcItems = ["All Clear", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Point", "Multiply", "Divide", "Add", "Subtract", "Equals"].map((t, i) => ({ i, id: t, text: t, role: "AXButton", state: "n/a" as const }));
  expect(calculatorPlan("compute 128 times 37", calcItems)!.map((s) => s.target)).toEqual(["All Clear", "1", "2", "8", "Multiply", "3", "7", "Equals"]);
  expect(calculatorPlan("15% of 2480", calcItems)!.map((s) => s.target).join(" ")).toBe("All Clear 2 4 8 0 Multiply 1 5 Divide 1 0 0 Equals");
  expect(calculatorPlan("what is the meaning of life", calcItems)).toBeNull();
  expect(webPlan("look up the University of Hong Kong on Wikipedia and tell me the year it was founded")![0]!.text).toBe("https://en.wikipedia.org/w/index.php?search=the%20University%20of%20Hong%20Kong");
  expect(webPlan("find the population of Hong Kong")![0]!.text).toContain("google.com/search?q=the%20population%20of%20Hong%20Kong");
  expect(writePlan("write 'The demo starts at 3pm'", [])![0]!.text).toBe("The demo starts at 3pm");
  expect(writePlan("create a note titled 'Groceries' with milk and eggs", [])![0]!.text).toBe("Groceries\n• milk\n• eggs");
  expect(writePlan("create a note titled 'Plan' about our long-term roadmap ideas", [])).toBeNull(); // a title without a list
  expect(writePlan("write a packing list for a hike", [])).toBeNull(); // creative text: not compiled
  expect(finderPlan("organise into folders by type", ["a.pdf", "b.png", "c.csv"])![0]!.text).toBe("Documents, Images, Spreadsheets");
  expect(finderPlan("sort the files into three folders: School, Money and Hackathon", ["a.pdf"])![0]!.text).toBe("School, Money, Hackathon");
});

test("titled lists are composed without an LLM", async () => {
  const { titledList, writePlan } = await import("../src/compile.ts");
  expect(titledList("In Notes create a note titled 'Groceries' with milk, eggs and bread")).toBe("Groceries\n• milk\n• eggs\n• bread");
  expect(writePlan("create a note titled 'Groceries' with milk, eggs and bread", [])![0]!.text).toBe("Groceries\n• milk\n• eggs\n• bread");
  expect(titledList("a note titled 'Ideas' with a long description of everything we might do at the hackathon this weekend")).toBeNull();
});

test("LLM only where needed: jev starts alone, escalates once when unsure, and the reason is recorded", async () => {
  const d = new SimCalc();
  // a brain that is only confident when it has a plan step to ground
  class OnlyWithPlan implements Brain {
    readonly kind = "jev" as const; readonly model = "x";
    async classify(f: Facts, items: Item[]): Promise<Decision> {
      const st = f.plan?.[f.planPos ?? 0];
      const it = st ? items.find((i) => i.text === st.target) : undefined;
      const conf = it ? 0.95 : 0.2;
      return { kind: "click", item: it?.i ?? 0, kindConf: conf, itemConf: conf, gate: conf, backend: "jev", model: "x", inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 1 };
    }
  }
  const planned: string[] = [];
  const helper: Helper & { canEscalate: boolean } = {
    canEscalate: true,
    async plan(_g, _a, _s, _i, why) {
      planned.push(why ? "llm" : "none");
      return { steps: why ? clicks("All Clear", "6", "Multiply", "7", "Equals") : [], costUsd: why ? 0.002 : 0, ms: 1 };
    },
    async writeText() { return { text: "", costUsd: 0, ms: 0 }; },
    async verify(_g, screen) { const ok = screen.includes("42"); return { achieved: ok, answer: ok ? "42" : "", reason: ok ? "shown" : "no", costUsd: 0, ms: 1 }; },
  };
  const task = await runTask(ctx(d, new OnlyWithPlan(), helper), newTask("compute 6 times 7"));
  expect(planned).toEqual(["none", "llm"]); // no LLM up front; one LLM plan when jev got stuck
  expect(task.llmCalls.length).toBe(1);
  expect(task.llmCalls[0]).toContain("jev stuck");
  expect(task.status).toBe("done");
  expect(task.answer).toBe("42");
});

test("known sites: several at once, in a new window; the place ('in a new Brave window') picks the app", async () => {
  const { openSitesPlan } = await import("../src/compile.ts");
  const p = openSitesPlan("open up claude dashbaord and typesafe dashboard in a new brave window")!;
  expect(p[0]!.text).toBe("https://platform.claude.com https://console.typesafe.ai"); // "dashbaord" (typo) still = the console
  expect(p[0]!.target).toBe("new window");
  expect(openSitesPlan("open the claude dashboard")![0]!.text).toBe("https://platform.claude.com");
  expect(openSitesPlan("search youtube for lofi")).toBeNull(); // a search, not just opening a site
  const { planWithJev } = await import("../src/manager.ts");
  const r = await planWithJev("open up claude dashbaord and typesafe dashboard in a new brave window", ["Safari", "Brave Browser", "Claude", "Notes"]);
  expect(r.tasks.map((t) => t.app)).toEqual(["Brave Browser"]);
});

test("tabs decide 'done' only for goals that are purely about opening pages", async () => {
  const { openOnly } = await import("../src/compile.ts");
  expect(openOnly("open the claude dashboard and typesafe dashboard in a new brave window")).toBe(true);
  expect(openOnly("open youtube in safari")).toBe(true);
  expect(openOnly("In Safari find how tall Lion Rock in Hong Kong is")).toBe(false); // a question: read the answer
  expect(openOnly("Open YouTube in Safari and play the first video")).toBe(false); // more to do after opening
});

test("a Word document: written in TextEdit, then saved as .docx in code (never Notes)", async () => {
  const { writePlan, WORD_DOC } = await import("../src/compile.ts");
  expect(WORD_DOC.test("make a seven day japan itinerary from hong kong and make a word doc about it.")).toBe(true);
  expect(WORD_DOC.test("write a note about the word of the day")).toBe(false);
  const plan = writePlan("make a word doc with a packing list", [{ id: 0, text: "First Text View", role: "AXTextArea", state: "empty" } as any])!;
  expect(plan.map((s) => s.action)).toEqual(["type", "save_as"]);
  const { planWithJev } = await import("../src/manager.ts");
  const r = await planWithJev("make a seven day japan itinerary from hong kong and make a word doc about it.", ["Notes", "TextEdit", "Safari"]);
  expect(r.tasks.map((t) => t.app)).toEqual(["TextEdit"]);
});

test("the hotkey router: jobs go to the agents, questions to explain mode (decided in code, no jev call)", async () => {
  const { route } = await import("../src/router.ts");
  const ctx = { lesson: false, agentsBusy: false };
  for (const t of ["Clear the calculator and compute 128 times 37", "In Calculator, what is 15% of 2480?", "can you open YouTube and play the first video", "make a seven day japan itinerary and make a word doc about it"]) {
    const r = await route(t, ctx);
    expect([t, r.to, r.via]).toEqual([t, "agents", "code"]);
  }
  for (const t of ["How do I work out 15 percent of 80 on this?", "What does the button under my mouse do?", "Underline the sentence with the population", "what's this", "next"]) {
    const r = await route(t, ctx);
    expect([t, r.to, r.via]).toEqual([t, "explain", "code"]);
  }
  expect((await route("stop", { lesson: false, agentsBusy: true })).to).toBe("stop");
  expect((await route("stop", { lesson: true, agentsBusy: false })).to).toBe("explain"); // clears the drawings
});

test("agent results are tidied for the widgets and made sayable for the voice", async () => {
  const { tidyAnswer, sayable, spokenSummary } = await import("../src/results.ts");
  expect(tidyAnswer("45×12 540")).toBe("45 × 12 = 540");
  expect(sayable("128×37 4,736")).toBe("128 times 37 is 4,736");
  expect(tidyAnswer("https://www.macrotrends.net › countries › hkg › populati... Total population is 7,500,962 , up 0.02%.")).toBe("Total population is 7,500,962, up 0.02%.");
  expect(sayable("saved ~/Documents/Backstage/Japan Itinerary.docx and opened it in Microsoft Word")).toBe("saved Japan Itinerary.docx and opened it in Microsoft Word");
  const t = (agent: string, app: string, goal: string, answer: string) => ({ agent, app, goal, answer, status: "done" }) as any;
  expect(spokenSummary([t("Mint-3", "Calculator", "Compute 45 times 12", "45×12 540"), t("Red-7", "TextEdit", "in TextEdit write 'Results coming soon'", "Results coming soon")], "finished"))
    .toBe("In Calculator: 45 times 12 is 540. TextEdit is done.");
  expect(spokenSummary([], "stopped")).toStartWith("Stopped.");
});

test("Maps and Stocks open straight to the answer from a link (no LLM, no clicking)", async () => {
  const { mapsPlan, stocksPlan } = await import("../src/compile.ts");
  expect(mapsPlan("In Maps, how long does it take to drive from the University of Hong Kong to Hong Kong International Airport")?.[0]?.text)
    .toBe("maps://?saddr=University%20of%20Hong%20Kong&daddr=Hong%20Kong%20International%20Airport&dirflg=d");
  expect(mapsPlan("in Maps how long does it take to walk from HKU to Kennedy Town")?.[0]?.text).toContain("dirflg=w");
  expect(stocksPlan("in Stocks check Sony stock price")?.[0]?.text).toBe("stocks://?symbol=SONY");
  expect(stocksPlan("check NVDA in Stocks")?.[0]?.text).toBe("stocks://?symbol=NVDA");
  expect(stocksPlan("In Stocks look at my watchlist")).toBeNull();
});

test("one long command splits into one task per app; a sentence that asks for nothing is context, not a task", async () => {
  const { planWithJev } = await import("../src/manager.ts");
  const names = ["Maps", "Weather", "Stocks", "Safari", "Brave Browser", "TextEdit", "Calendar", "Notes"];
  const p = await planWithJev("I am flying to Tokyo tomorrow. In Maps, how long does it take to drive from HKU to the airport, in Weather check the weather in Tokyo, in Stocks check Sony stock price, in Safari find how much 10000 yen is in HKD, in Brave find the flight time from Hong Kong to Tokyo, and make a word doc with a 3 day Tokyo itinerary", names);
  expect(p.tasks.map((t) => t.app)).toEqual(["Maps", "Weather", "Stocks", "Safari", "Brave Browser", "TextEdit"]);
});

test("many agents: each spoken result is cut to its gist", async () => {
  const { spokenSummary } = await import("../src/results.ts");
  const t = (agent: string, app: string, goal: string, answer: string) => ({ agent, app, goal, answer, status: "done" }) as any;
  const s = spokenSummary([
    t("Mint-3", "Maps", "drive", "Hong Kong International Airport 29 min, 12:06 ETA · 35 km, Fastest Tolls required"),
    t("Red-7", "Weather", "check the weather", "window title: Tokyo Tokyo, 17 degrees Celsius, Partly Cloudy, High: 23 degrees Celsius"),
    t("Cyan-5", "TextEdit", "make a word doc", "saved ~/Documents/Backstage/Plan.docx and opened it in Microsoft Word"),
  ], "finished");
  expect(s).toBe("In Maps: Hong Kong International Airport 29 min, 35 km. In Weather: Tokyo, 17 degrees Celsius, Partly Cloudy. In TextEdit: your Word document is ready.");
});

test("web answers: a split sentence is joined, and answer-shaped lines make the shortlist", async () => {
  const { joinFragments, relevantLines } = await import("../src/perceive.ts");
  expect(joinFragments(["A Symphony of Lights starts every night at", "8:00 p.m. sharp", "Tourism Commission"])).toEqual(["A Symphony of Lights starts every night at 8:00 p.m. sharp", "Tourism Commission"]);
  const filler = Array.from({ length: 40 }, (_, i) => `Symphony of Lights result ${i}`);
  const picked = relevantLines([...filler, "8pm (20:00) sharp, every night"], "find what time the Symphony of Lights starts", 30, 8);
  expect(picked).toContain("8pm (20:00) sharp, every night");
  const { weatherPlan } = await import("../src/compile.ts");
  expect(weatherPlan("in Weather check the weather in Hong Kong")).toEqual([{ action: "pick_city", text: "Hong Kong" }]);
});
