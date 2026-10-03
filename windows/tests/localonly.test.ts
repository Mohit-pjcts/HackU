import { expect, test } from "bun:test";
import { fromThisComputer } from "../src/localonly";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/tasks", { method: "POST", headers });

test("only this computer's panel may call the server", () => {
  expect(fromThisComputer(req({ host: "127.0.0.1:3000" }))).toBe(true);
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true);
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toBe(false);
  expect(fromThisComputer(req({ host: "127.0.0.1:3000", origin: "null" }))).toBe(false);
  expect(fromThisComputer(req({ host: "evil.example:3000" }))).toBe(false);
});
