import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fromThisComputer } from "../src/localonly.ts";
import { clickForbidden, typingForbidden } from "../src/safety.ts";
import { FileOps, safeRoot } from "../src/fsops.ts";

const req = (headers: Record<string, string>, method = "POST") => new Request("http://127.0.0.1:3000/api/run", { method, headers });

test("only this computer's panel may call the server", () => {
  expect(fromThisComputer(req({ host: "127.0.0.1:3000" }))).toBe(true); // the overlay, scripts: no Origin
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true); // the panel
  expect(fromThisComputer(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toBe(false); // a web page
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "null" }))).toBe(false); // a sandboxed frame or a file
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "http://localhost:3000" }))).toBe(false); // another origin
  expect(fromThisComputer(req({ host: "evil.example:3000" }))).toBe(false); // DNS rebinding
});

test("agents never type secrets and never pay or delete unasked", () => {
  for (const l of ["Password", "Card number", "CVV", "Security code", "One-time code"]) expect(typingForbidden(l)).not.toBeNull();
  for (const l of ["Search", "Message", "To:", "Subject"]) expect(typingForbidden(l)).toBeNull();
  expect(clickForbidden("Buy now", "find the price of AirPods")).not.toBeNull();
  expect(clickForbidden("Delete", "open my notes")).not.toBeNull();
  expect(clickForbidden("Delete", "delete the draft called test")).toBeNull();
  expect(clickForbidden("Place order", "place the order")).toBeNull();
  expect(clickForbidden("Send", "message Sohan hi")).toBeNull(); // sending has its own rule
  expect(clickForbidden("7", "what is 7 times 8")).toBeNull();
});

test("the undo script cannot run commands hidden in a file name", () => {
  const root = mkdtempSync(join(tmpdir(), "bs-undo-"));
  const evil = "a $(touch pwned) `id` 'quote'.txt";
  writeFileSync(join(root, evil), "x");
  const ops = new FileOps(root, join(root, ".undo"), "t1");
  ops.makeFolder("Docs");
  expect(ops.moveFile(evil, "Docs").ok).toBe(true);
  const script = readFileSync(ops.undoFile, "utf8");
  expect(script).toContain(`'${join(root, "Docs", "a $(touch pwned) `id` ")}'\\''quote'\\''.txt'`);
  expect(script).not.toContain('"');
});

test("a link inside the home folder cannot lead outside it", () => {
  const link = join(homedir(), `bs-link-test-${process.pid}`);
  symlinkSync(tmpdir(), link);
  try { expect(safeRoot(link)).not.toBeNull(); } finally { rmSync(link); }
});
