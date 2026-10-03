// Appends every step as one JSON line to runs/<runId>/steps.jsonl and pushes it to live subscribers (the panel's SSE).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogLine, Logger } from "./contracts.ts";

export class RunLogger implements Logger {
  readonly file: string;
  readonly lines: LogLine[] = [];
  private subs = new Set<(l: LogLine) => void>();

  constructor(
    readonly runId: string,
    baseDir = join(import.meta.dir, "..", "runs"),
  ) {
    const dir = join(baseDir, runId);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "steps.jsonl");
  }

  write(line: LogLine): void {
    this.lines.push(line);
    appendFileSync(this.file, JSON.stringify(line) + "\n");
    for (const s of this.subs) {
      try {
        s(line);
      } catch {
        /* a dead subscriber must never break a run */
      }
    }
  }

  subscribe(fn: (l: LogLine) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export const nowIso = () => new Date().toISOString();
