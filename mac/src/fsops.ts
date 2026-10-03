// Scripted file operations for Finder tasks. A background agent cannot move files through Finder's GUI: Cua refuses
// background drags on macOS (measured: background_unavailable), and the keyboard shortcuts are refused too. So moves
// are file-system calls, under strict rules, and every one is DISCLOSED as "scripted" in the log and the panel:
//   * only inside the one folder the Finder window shows (its direct children), never outside
//   * never delete, never overwrite (an existing name is skipped and reported)
//   * every move is written to an undo script you can run
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AxElement, Observation } from "./contracts.ts";

/** the folder a Finder window shows, read from its path bar (Macintosh HD › Users › … › folder) */
export function finderFolder(obs: Observation): string | null {
  const pathList = obs.elements.find((e) => e.role === "AXList" && e.label === "path");
  if (!pathList) return null;
  const parts = obs.elements.filter((e: AxElement) => e.parent === pathList.index).map((e) => (e.value ?? e.label ?? "").trim());
  if (!parts.length) return null;
  let rest = parts[0] === "Macintosh HD" ? parts.slice(1) : parts;
  // the path bar also shows the SELECTED item: cut at the folder the window shows (its title)
  const cut = rest.lastIndexOf(obs.window.title);
  if (cut >= 0) rest = rest.slice(0, cut + 1);
  let path = "/" + rest.join("/");
  while (path !== "/" && (!existsSync(path) || !statSync(path).isDirectory())) path = path.slice(0, path.lastIndexOf("/")) || "/";
  return path;
}

/** folders an agent may organise: inside your home folder, not the home folder itself, not Library */
export function safeRoot(dir: string): string | null {
  const home = homedir();
  const abs = resolve(dir);
  if (!abs.startsWith(home + "/") || abs === home) return "only folders inside your home folder (not the home folder itself) can be organised";
  if (/\/Library(\/|$)|\/\.[^/]+/.test(abs.slice(home.length))) return "system and hidden folders are off limits";
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return "that folder does not exist";
  return null;
}

const badName = (n: string) => !n.trim() || n.includes("/") || n.includes("\0") || n === "." || n === ".." || n.startsWith(".");

/** the loose files directly inside a folder (not folders, not hidden files) */
export function looseFiles(root: string): string[] {
  return readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isFile()).sort();
}

/** a short listing (2 levels) of a folder, for the verifier */
export function listTree(root: string, max = 80): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).filter((n) => !n.startsWith(".")).sort()) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) {
      const inner = readdirSync(p).filter((n) => !n.startsWith("."));
      out.push(`${name}/ : ${inner.length ? inner.join(", ") : "(empty)"}`);
    } else out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

export class FileOps {
  readonly undoFile: string;
  constructor(readonly root: string, undoDir: string, taskId: string) {
    mkdirSync(undoDir, { recursive: true });
    this.undoFile = join(undoDir, `undo-${taskId}.sh`);
    if (!existsSync(this.undoFile)) writeFileSync(this.undoFile, `#!/bin/sh\n# Undo the scripted file moves of task ${taskId} (run the lines bottom to top)\n`);
  }

  makeFolder(name: string): { ok: boolean; detail: string } {
    if (badName(name)) return { ok: false, detail: `refused folder name "${name}"` };
    const p = join(this.root, name);
    if (existsSync(p)) return statSync(p).isDirectory() ? { ok: true, detail: `folder "${name}" already exists` } : { ok: false, detail: `"${name}" exists and is not a folder` };
    mkdirSync(p);
    appendFileSync(this.undoFile, `rmdir ${JSON.stringify(p)}  # only succeeds if empty\n`);
    return { ok: true, detail: `created folder "${name}"` };
  }

  moveFile(file: string, folder: string): { ok: boolean; detail: string } {
    if (badName(file) || badName(folder)) return { ok: false, detail: `refused names "${file}" → "${folder}"` };
    const src = join(this.root, file);
    const dstDir = join(this.root, folder);
    if (!existsSync(src)) return { ok: false, detail: `"${file}" is not in this folder` };
    if (!existsSync(dstDir) || !statSync(dstDir).isDirectory()) return { ok: false, detail: `no folder "${folder}" here` };
    const dst = join(dstDir, basename(file));
    if (existsSync(dst)) return { ok: false, detail: `"${folder}/${file}" already exists: not overwriting` };
    renameSync(src, dst);
    appendFileSync(this.undoFile, `mv ${JSON.stringify(dst)} ${JSON.stringify(src)}\n`);
    return { ok: true, detail: `moved "${file}" → ${folder}/` };
  }
}
