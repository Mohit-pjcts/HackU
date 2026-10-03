// The fast lane: clicks and text inserts sent straight through the accessibility API by a small native helper
// (native/FastLane.swift), instead of through Cua Driver's single input lane.
// Measured: 2-4 ms per action instead of ~0.6 s, and agents in different apps really act at the same time.
// Anything the fast lane can't do safely comes back as not ok, and the driver uses Cua for it.
// FAST_INPUT=off turns it off.
import type { Subprocess } from "bun";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Rect } from "./contracts.ts";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "native", "FastLane.swift");
const BIN = join(ROOT, "native", "build", "fastlane");

export interface FastTarget { pid: number; frame: Rect; role: string; label?: string }
export interface FastResult { ok: boolean; ms: number; how?: string; error?: string }

export class FastLane {
  private proc?: Subprocess<"pipe", "pipe", "ignore">;
  private next = 1;
  private waiting = new Map<number, (r: FastResult) => void>();
  private state: "starting" | "on" | "off" = "starting";
  private ready: Promise<void>;
  reason = "";

  constructor() {
    this.ready = this.start().catch((e) => this.off(String(e?.message ?? e)));
  }

  /** usable right now (it never makes a caller wait for start-up) */
  get on() { return this.state === "on"; }

  async whenReady() { await this.ready; return this.on; }

  private off(why: string) {
    this.state = "off";
    this.reason = why;
    for (const r of this.waiting.values()) r({ ok: false, ms: 0, error: "fast lane stopped" });
    this.waiting.clear();
    console.log(`[fast lane] off: ${why} (clicks and typing go through Cua)`);
  }

  private async start() {
    if (process.env.FAST_INPUT === "off") return this.off("FAST_INPUT=off");
    if (process.platform !== "darwin") return this.off("macOS only");
    // (re)build when missing or older than its source: a few seconds, once
    if (!existsSync(BIN) || statSync(BIN).mtimeMs < statSync(SRC).mtimeMs) {
      mkdirSync(join(ROOT, "native", "build"), { recursive: true });
      const b = Bun.spawnSync(["swiftc", "-O", "-swift-version", "5", SRC, "-o", BIN, "-framework", "AppKit", "-framework", "ApplicationServices"], { stderr: "pipe" });
      if (b.exitCode !== 0) return this.off(`could not build the helper: ${b.stderr.toString().split("\n").find((l) => /error/.test(l)) ?? "swiftc failed"}`);
    }
    const proc = Bun.spawn([BIN], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.proc = proc;
    const first = new Promise<any>((resolve) => this.readLines(proc, resolve));
    const hello = await Promise.race([first, Bun.sleep(3000).then(() => undefined)]);
    if (!hello?.ready) return this.off("the helper didn't start");
    if (!hello.trusted) return this.off("no Accessibility permission for the app that runs Backstage (System Settings › Privacy & Security › Accessibility)");
    this.state = "on";
    proc.exited.then(() => { if (this.state === "on") this.off("the helper exited"); });
    console.log("[fast lane] on: clicks and native text fields go straight through accessibility; Cua for the rest");
  }

  private async readLines(proc: Subprocess<"pipe", "pipe", "ignore">, hello: (j: any) => void) {
    const dec = new TextDecoder();
    let buf = "";
    let first = true;
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let j: any;
        try { j = JSON.parse(line); } catch { continue; }
        if (first) { first = false; hello(j); continue; }
        const done = this.waiting.get(j.id);
        if (done) { this.waiting.delete(j.id); done({ ok: !!j.ok, ms: j.ms ?? 0, how: j.how, error: j.error }); }
      }
    }
  }

  private request(op: "press" | "type", t: FastTarget, text?: string): Promise<FastResult> {
    if (!this.on || !this.proc) return Promise.resolve({ ok: false, ms: 0, error: "fast lane off" });
    const id = this.next++;
    const msg = { id, op, pid: t.pid, x: t.frame.x, y: t.frame.y, w: t.frame.w, h: t.frame.h, role: t.role, label: t.label ?? "", text };
    return new Promise<FastResult>((resolve) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, ms: 2500, error: "no answer in 2.5 s" }); }, 2500);
      this.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.proc!.stdin.write(JSON.stringify(msg) + "\n");
      this.proc!.stdin.flush();
    });
  }

  press(t: FastTarget) { return this.request("press", t); }
  type(t: FastTarget, text: string) { return this.request("type", t, text); }
}
