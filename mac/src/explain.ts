// Explain mode: press the hotkey, ask about anything on your screen, and Backstage answers out loud while it draws on
// top of your screen (rings, arrows, circles, underlines, labels) to show what it means.
//
// Privacy: the screen is captured ONLY when you press the hotkey (one screenshot of the main display + the accessibility
// tree of the window in front). The screenshot is deleted after the answer; the journal keeps only the text.
//
// Precision: pointing does not rely on the model's pixel guess alone. The model gets the list of controls in the front
// window WITH their exact frames (from the accessibility tree) and points at them by id; a point it gives in the picture
// is snapped to the smallest control under it. Only when nothing is there is the drawing placed from the picture.
import type Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, Rect } from "./contracts.ts";
import { cua } from "./driver.ts";
import { frontApp } from "./apps.ts";
import { callTool, hasClaude, LLM_BRAIN_MODEL } from "./llm.ts";
import { Voice } from "./voice.ts";

export const EXPLAIN_MODEL = process.env.EXPLAIN_MODEL ?? LLM_BRAIN_MODEL;
const SESSION = "Mint-3"; // the Cua session label used for reading windows

export interface Point { x: number; y: number }
/** everything is in GLOBAL screen points, origin top-left of the main display (the space Cua's frames use) */
export interface Shape {
  kind: "ring" | "box" | "circle" | "arrow" | "underline" | "label";
  x?: number; y?: number; w?: number; h?: number;
  from?: Point; to?: Point;
  text?: string;
}
export type ToOverlay =
  | { type: "status"; text: string }
  | { type: "answer"; seq: number; say: string; shapes: Shape[]; step?: { index: number; total: number }; fadeMs: number; audio: "follows" | "mac" }
  // the spoken answer, in parts, in order: an MP3 (base64), or text for the Mac voice when there's no audio
  | { type: "audio"; seq: number; part: number; parts: number; mp3: string }
  | { type: "speak"; seq: number; part: number; parts: number; say: string }
  | { type: "clear" }
  | { type: "captured" } // the screenshot is taken (in recording mode the overlay hid for it)
  | { type: "error"; text: string };

interface Control { id: number; role: string; label: string; frame: Rect }
interface Capture {
  png?: string;
  imgW: number; imgH: number; // the picture the model sees, in pixels
  screenW: number; screenH: number; // the main display, in points
  app?: string; windowTitle?: string;
  controls: Control[];
  ms: number;
  error?: string;
}

/** what the model answers with: coordinates are in the PICTURE's pixels, or a control id from the list */
interface ModelShape { kind: Shape["kind"]; control?: number; x?: number; y?: number; w?: number; h?: number; from_x?: number; from_y?: number; text?: string }
interface ModelAnswer { steps: { say: string; shapes?: ModelShape[] }[] }

const KINDS = ["ring", "box", "circle", "arrow", "underline", "label"] as const;
const TOOL = {
  name: "explain",
  description: "Answer the user about their screen: what to say out loud and what to draw on the screen.",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "ONE step for a plain question. 2 to 6 steps for 'how do I ...' (a lesson: one action per step, the user says 'next' to continue).",
        items: {
          type: "object",
          properties: {
            say: { type: "string", description: "What to say out loud for this step: short, friendly, 1 to 3 sentences, in the user's language. Refer to what you draw ('the button I circled')." },
            shapes: {
              type: "array",
              description: "What to draw for this step (0 to 8 shapes; a request to label or diagram the screen can use all 8). Point at a control from the list by its id whenever possible.",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: [...KINDS], description: "ring = highlight a control; box = a region; circle = an area; underline = a line of text; arrow = point at something (from -> to); label = a short note" },
                  control: { type: "integer", description: "id of a control from the list (exact position). Prefer this over coordinates." },
                  x: { type: "number", description: "picture pixels: left (or the point an arrow/label points at)" },
                  y: { type: "number", description: "picture pixels: top (or the point an arrow/label points at)" },
                  w: { type: "number", description: "picture pixels: width (regions only)" },
                  h: { type: "number", description: "picture pixels: height (regions only)" },
                  from_x: { type: "number", description: "arrows: where the arrow starts, picture pixels (optional)" },
                  from_y: { type: "number" },
                  text: { type: "string", description: "label text (2 to 6 words), or a caption for the shape" },
                },
                required: ["kind"],
              },
            },
          },
          required: ["say"],
        },
      },
    },
    required: ["steps"],
  },
};

const NEXT = 'Say "next" when you\'re ready.';
const ACTIONABLE = /^AX(Button|MenuButton|PopUpButton|CheckBox|RadioButton|TextField|TextArea|SearchField|ComboBox|Link|Tab|Cell|Row|Slider|MenuItem|MenuBarItem|Image|StaticText|Heading|Incrementor|DisclosureTriangle|ColorWell|SegmentedControl)$/;

export class Explainer {
  private pending?: Promise<Capture>;
  private lesson?: { question: string; steps: { say: string; shapes: Shape[] }[]; index: number };
  private journal: string;
  private seq = 0;
  readonly voice = new Voice();

  constructor(private driver: Driver, private send: (m: ToOverlay) => void, runsDir: string) {
    mkdirSync(runsDir, { recursive: true });
    this.journal = join(runsDir, "explain-journal.jsonl");
    try { rmSync(join(tmpdir(), "backstage-explain"), { recursive: true, force: true }); } catch { /* screenshots left by an earlier run */ }
    this.voice.warm();
  }

  /** the hotkey went down: capture NOW (before the buddy or the typing box can appear on the screen) */
  begin() {
    this.discard(); // a capture nobody asked about (the typing box was cancelled): gone
    const p = (this.pending = this.capture());
    p.then(() => this.send({ type: "captured" }), () => this.send({ type: "captured" }));
    // no question within a minute (Esc, an empty box): the screenshot is deleted, not left in the temp folder
    setTimeout(() => { if (this.pending === p) this.discard(); }, 60_000);
  }

  get inLesson() { return !!this.lesson; }

  /** move through a lesson (spoken words, or the overlay's keys: Option + arrow) */
  go(to: "next" | "back" | "repeat") {
    if (!this.lesson) return;
    this.step(to === "next" ? this.lesson.index + 1 : to === "back" ? this.lesson.index - 1 : this.lesson.index);
  }

  /** end the lesson and clear the screen ("stop", or Esc twice) */
  dismiss() {
    this.lesson = undefined;
    this.seq++; // audio still on its way for the old answer is dropped
    this.send({ type: "clear" });
  }

  /** the words were a job for the agents after all: throw away the screenshot taken when the hotkey went down */
  discard() {
    const p = this.pending;
    this.pending = undefined;
    p?.then((c) => { if (c.png) try { rmSync(c.png); } catch { /* gone */ } });
  }

  /** say something with no drawing (the agents' "on it" and their results); it stays on screen for `fadeMs` */
  say(text: string, fadeMs = 7000) { this.answer(text, [], fadeMs); }

  /** a question (spoken or typed). Lesson words are handled in code, without an LLM. */
  async ask(text: string, cursor?: Point) {
    const q = text.trim();
    if (!q) { this.discard(); this.send({ type: "clear" }); return; }
    const w = q.toLowerCase().replace(/[.!?,]/g, "").trim();
    if (/^(stop|cancel|clear|never ?mind|hide|that's all|thanks|thank you)$/.test(w)) { this.discard(); return this.dismiss(); }
    if (this.lesson && /^(next|next step|continue|go on|ok|okay|done|got it|and then|then what)$/.test(w)) { this.discard(); return this.go("next"); }
    if (this.lesson && /^(repeat|again|say that again|what|huh|sorry|come again|back|previous)$/.test(w)) { this.discard(); return this.go(/back|previous/.test(w) ? "back" : "repeat"); }
    if (!hasClaude()) { this.send({ type: "error", text: "ANTHROPIC_API_KEY is missing in .env" }); return; }

    this.send({ type: "status", text: "looking at your screen…" });
    const mine = this.pending; // taken now, so the one-minute clean-up can't delete it while it's in use
    this.pending = undefined;
    const cap = await (mine ?? this.capture());
    if (!cap.png) { this.send({ type: "error", text: `could not see the screen: ${cap.error ?? "no capture"}` }); return; }
    try {
      this.send({ type: "status", text: "thinking…" });
      const answer = await this.think(q, cap, cursor);
      const steps = answer.input.steps.filter((s) => s.say?.trim()).slice(0, 6).map((s) => ({ say: s.say.trim(), shapes: (s.shapes ?? []).flatMap((m) => this.place(m, cap)) }));
      if (!steps.length) { this.send({ type: "error", text: "no answer" }); return; }
      this.lesson = { question: q, steps, index: 0 };
      this.write({ t: new Date().toISOString(), question: q, app: cap.app, window: cap.windowTitle, steps: steps.map((s) => ({ say: s.say, shapes: s.shapes.length })), model: EXPLAIN_MODEL, usd: +answer.costUsd.toFixed(5), ms: answer.ms, captureMs: cap.ms, controls: cap.controls.length });
      console.log(`[explain] "${q.slice(0, 60)}" → ${steps.length} step(s), ${steps.reduce((a, s) => a + s.shapes.length, 0)} shape(s) · ${answer.ms} ms · $${answer.costUsd.toFixed(4)} · ${cap.controls.length} controls from ${cap.app ?? "?"}`);
      this.step(0);
    } catch (e: any) {
      this.send({ type: "error", text: String(e?.message ?? e).slice(0, 160) });
    } finally {
      try { rmSync(cap.png); } catch { /* already gone */ }
    }
  }

  private step(i: number) {
    const l = this.lesson;
    if (!l) return;
    if (i >= l.steps.length) { this.lesson = undefined; return this.answer("That's everything. Ask me anything else.", [], 4000); }
    l.index = Math.max(0, i);
    const s = l.steps[l.index]!;
    const total = l.steps.length;
    const more = total > 1 && l.index < total - 1;
    // a lesson step stays until you continue; a single answer fades
    this.answer(this.sayFor(l.index), s.shapes, more ? 0 : 9000, total > 1 ? { index: l.index, total } : undefined);
    if (more) for (const t of this.sayFor(l.index + 1)) for (const p of Voice.parts(t)) void this.voice.speak(p); // fetch the next step while this one plays
  }

  private sayFor(i: number) {
    const l = this.lesson!;
    const more = l.steps.length > 1 && i < l.steps.length - 1;
    return more ? [l.steps[i]!.say, NEXT] : [l.steps[i]!.say];
  }

  /** draw now; the voice follows part by part as soon as each part's audio is ready (cached for repeat/back) */
  private answer(say: string | string[], shapes: Shape[], fadeMs: number, step?: { index: number; total: number }) {
    const seq = ++this.seq;
    const lines = typeof say === "string" ? [say] : say;
    this.send({ type: "answer", seq, say: lines.join(" "), shapes, step, fadeMs, audio: this.voice.on ? "follows" : "mac" });
    if (!this.voice.on) return;
    const parts = lines.flatMap((t) => Voice.parts(t));
    const audio = parts.map((t) => this.voice.speak(t)); // all requested now, sent in order
    void (async () => {
      for (const [i, p] of audio.entries()) {
        const v = await p;
        if (this.seq !== seq) return; // a newer answer took over
        if (v.audio) this.send({ type: "audio", seq, part: i, parts: parts.length, mp3: Buffer.from(v.audio).toString("base64") });
        else this.send({ type: "speak", seq, part: i, parts: parts.length, say: parts[i]! });
        console.log(`[voice] ${i + 1}/${parts.length} ${v.audio ? (v.cached ? "already fetched" : `${v.model} ${v.ms} ms · ${v.credits} credits`) : `Mac voice (${v.error ?? "no audio"})`}`);
      }
    })();
  }

  // ---------- seeing ----------

  private async capture(): Promise<Capture> {
    const t0 = performance.now();
    const dir = join(tmpdir(), "backstage-explain");
    mkdirSync(dir, { recursive: true });
    const png = join(dir, `screen-${Date.now()}.png`);
    const [shot, ax] = await Promise.all([
      cua("get_desktop_state", { max_image_dimension: 1568, screenshot_out_file: png }, 10000),
      this.frontControls().catch((e) => ({ controls: [] as Control[], error: String(e) })),
    ]);
    const j = shot.json;
    if (!j || !existsSync(png)) return { imgW: 0, imgH: 0, screenW: 0, screenH: 0, controls: [], ms: 0, error: shot.raw.slice(0, 160) || "screen capture failed (Screen Recording permission for Cua Driver?)" };
    return {
      png,
      imgW: j.screenshot_width, imgH: j.screenshot_height,
      screenW: j.screen_width, screenH: j.screen_height,
      app: (ax as any).app, windowTitle: (ax as any).windowTitle,
      controls: ax.controls,
      ms: Math.round(performance.now() - t0),
    };
  }

  /**
   * the controls the user can see, with their exact frames (screen points), small enough to list for the model.
   * Read from the front app's top window AND the topmost window on screen when that belongs to another app
   * (a small window can sit on top while focus is elsewhere).
   */
  private async frontControls(): Promise<{ controls: Control[]; app?: string; windowTitle?: string }> {
    const [app, { windows }] = await Promise.all([frontApp(), this.driver.listWindows()]);
    const visible = windows
      .filter((w) => w.is_on_screen !== false && w.on_current_space !== false && w.bounds.height > 60 && (w as any).layer === 0)
      .sort((a, b) => ((a as any).z_index ?? 0) - ((b as any).z_index ?? 0));
    const front = visible.find((w) => w.app_name === app);
    const wins = [front, visible[0]].filter((w, i, a): w is NonNullable<typeof w> => !!w && a.findIndex((x) => x?.window_id === w.window_id) === i);
    if (!wins.length) return { controls: [], app };
    const reads = await Promise.all(wins.map((w, i) =>
      this.driver.observe(`${SESSION}${i ? "b" : ""}`, { pid: w.pid, windowId: w.window_id, app: w.app_name, title: w.title }, { timeoutMs: 1500 }).catch(() => undefined)));
    const seen = new Set<string>();
    const controls: Control[] = [];
    for (const o of reads) {
      for (const e of o?.elements ?? []) {
        const f = e.frame;
        if (!f || f.w < 4 || f.h < 4 || !ACTIONABLE.test(e.role)) continue;
        const label = (e.label || e.value || "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!label) continue;
        const key = `${e.role}|${label}|${Math.round(f.x)}|${Math.round(f.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        controls.push({ id: controls.length, role: e.role.replace(/^AX/, ""), label, frame: f });
        if (controls.length >= 150) break;
      }
    }
    const shown = wins.map((w) => w.app_name).join(" + ");
    return { controls, app: shown, windowTitle: wins.map((w) => w.title).filter(Boolean).join(" / ") };
  }

  // ---------- thinking ----------

  private async think(question: string, cap: Capture, cursor?: Point) {
    const k = cap.imgW / cap.screenW; // picture pixels per screen point
    const px = (v: number) => Math.round(v * k);
    const list = cap.controls.map((c) => `[${c.id}] ${c.role} "${c.label}" at x=${px(c.frame.x)} y=${px(c.frame.y)} w=${px(c.frame.w)} h=${px(c.frame.h)}`).join("\n");
    const user: Anthropic.ContentBlockParam[] = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: readFileSync(cap.png!).toString("base64") } },
      {
        type: "text",
        text:
          `The picture is the user's screen, ${cap.imgW}×${cap.imgH} pixels.` +
          (cursor ? ` The mouse pointer is at x=${px(cursor.x)} y=${px(cursor.y)} (they may mean what is under it).` : "") +
          (cap.app ? ` The app in front is ${cap.app}${cap.windowTitle ? ` ("${cap.windowTitle}")` : ""}.` : "") +
          (list ? `\n\nControls in that window, with their exact positions in picture pixels (point at them by id):\n${list}` : "") +
          `\n\nThe user asks: "${question}"`,
      },
    ];
    return callTool<ModelAnswer>({
      model: EXPLAIN_MODEL,
      system:
        "You are Backstage, a friendly tutor that can see the user's screen and draw on it. Explain what they ask about, " +
        "pointing at the exact things on screen. Speak like a patient teacher: short sentences, no jargon, no markdown, " +
        "and answer in the language the user asked in. Draw only what helps: ring a control you talk about (by its id), " +
        "underline a line of text you quote, circle an area, an arrow when direction matters, a short label to name things. " +
        "For 'how do I…' questions give a lesson: one action per step, in order, each with its own drawing. " +
        "If something is not visible on the screen, say so instead of guessing. Never invent controls.",
      user,
      tool: TOOL,
      maxTokens: 1200,
    });
  }

  /** model shape (picture pixels or a control id) -> screen points, snapped to a real control when possible */
  private place(m: ModelShape, cap: Capture): Shape[] {
    const one = this.placeOne(m, cap);
    if (!one) return [];
    // an underline over several lines of text: one line under EACH text run it covers (exact frames from the tree)
    if (one.kind === "underline" && m.control === undefined && one.h! > 26) {
      const r = { x: one.x!, y: one.y!, w: one.w!, h: one.h! };
      const runs = cap.controls.filter((c) => {
        if (c.role !== "StaticText" && c.role !== "Link") return false;
        const f = c.frame;
        const ix = Math.max(0, Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x));
        const iy = Math.max(0, Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y));
        return ix * iy >= 0.5 * f.w * f.h && f.h < 40;
      });
      // merge runs on the same line into one underline per line
      const lines = new Map<number, Rect>();
      for (const c of runs) {
        const key = Math.round((c.frame.y + c.frame.h) / 6);
        const l = lines.get(key);
        lines.set(key, l ? { x: Math.min(l.x, c.frame.x), y: Math.min(l.y, c.frame.y), w: Math.max(l.x + l.w, c.frame.x + c.frame.w) - Math.min(l.x, c.frame.x), h: Math.max(l.h, c.frame.h) } : { ...c.frame });
      }
      if (lines.size) {
        const sorted = [...lines.values()].sort((a, b) => a.y - b.y);
        return sorted.map((f, i) => ({ kind: "underline" as const, ...f, text: i === sorted.length - 1 ? one.text : undefined }));
      }
    }
    return [one];
  }

  private placeOne(m: ModelShape, cap: Capture): Shape | undefined {
    if (!KINDS.includes(m.kind as any)) return undefined;
    const k = cap.screenW / cap.imgW; // screen points per picture pixel
    const ctl = m.control !== undefined ? cap.controls.find((c) => c.id === m.control) : undefined;
    let rect: Rect | undefined = ctl?.frame;
    let pt: Point | undefined;
    if (!rect && m.x !== undefined && m.y !== undefined) {
      if (m.w && m.h) rect = { x: m.x * k, y: m.y * k, w: m.w * k, h: m.h * k };
      else pt = { x: m.x * k, y: m.y * k };
    }
    // a point (or a small region) inside a known control snaps to that control's exact frame
    if (!ctl && (m.kind === "ring" || m.kind === "underline" || m.kind === "circle") && (pt || (rect && rect.w * rect.h < 160 * 60))) {
      const c = pt ?? { x: rect!.x + rect!.w / 2, y: rect!.y + rect!.h / 2 };
      const under = cap.controls.filter((x) => c.x >= x.frame.x && c.x <= x.frame.x + x.frame.w && c.y >= x.frame.y && c.y <= x.frame.y + x.frame.h).sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0];
      if (under) { rect = under.frame; pt = undefined; }
    }
    if (!rect && pt) rect = { x: pt.x - 20, y: pt.y - 20, w: 40, h: 40 };
    if (!rect) return undefined;
    const clamp = (r: Rect): Rect => ({ x: Math.max(0, Math.min(r.x, cap.screenW - 4)), y: Math.max(0, Math.min(r.y, cap.screenH - 4)), w: Math.max(4, r.w), h: Math.max(4, r.h) });
    const r = clamp(rect);
    const text = m.text?.slice(0, 80);
    if (m.kind === "arrow") {
      const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      const from = m.from_x !== undefined && m.from_y !== undefined ? { x: m.from_x * k, y: m.from_y * k } : { x: Math.max(40, to.x - 140), y: Math.max(40, to.y - 110) };
      return { kind: "arrow", from, to, text };
    }
    if (m.kind === "label") return { kind: "label", x: r.x + r.w / 2, y: r.y + r.h / 2, text: text ?? "" };
    return { kind: m.kind, x: r.x, y: r.y, w: r.w, h: r.h, text };
  }

  private write(entry: object) {
    try { appendFileSync(this.journal, JSON.stringify(entry) + "\n"); } catch { /* the journal is optional */ }
  }
}
