// Checks everything the agent needs BEFORE a run, and fixes what it safely can (opens the form in Safari).
// Run on its own with `bun run preflight`.
import type { Driver } from "./contracts.ts";
import { Oracle, pageIsClaimsForm } from "./adapters/claims-form.ts";
import { CliDriver, cua } from "./driver.ts";
import { perceive } from "./perceive.ts";
import { findWindows } from "./windows.ts";

export const FORM_URL = "http://127.0.0.1:8765/";
export const PINNED_DRIVER = "0.32.0";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fatal: boolean;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return (o + e).trim();
}

export async function runPreflight(driver: Driver, agent: string, opts: { openForm?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, fatal = true) => checks.push({ name, ok, detail, fatal });

  const bin = Bun.which("cua-driver") ?? `${process.env.HOME}/.local/bin/cua-driver`;
  const ver = await sh([bin, "--version"]).catch(() => "");
  add("Cua Driver version", ver.includes(PINNED_DRIVER), ver || "cua-driver not found (install: see README)", false);

  const perm = await sh([bin, "permissions", "status"]).catch(() => "");
  const granted = /Accessibility:\s+✅/.test(perm) && /Screen Recording:\s+✅/.test(perm);
  add("macOS permissions", granted, granted ? "Accessibility + Screen Recording granted" : "not granted: run `cua-driver permissions grant`, then RESTART the daemon (bash scripts/daemon.sh)");
  if (!granted) return checks;

  try {
    const r = await new Oracle().all();
    add("Replica form + database", true, `reachable on :8765 (${r.length} claims stored)`);
  } catch (e: any) {
    add("Replica form + database", false, `not reachable on :8765 (${e?.message ?? e})`);
  }

  add("TypeSafe key", !!process.env.TYPESAFE_API_KEY, process.env.TYPESAFE_API_KEY ? "present (jev will decide)" : "missing: the offline policy classifier will decide, clearly labelled", false);

  await driver.ensureSession(agent).catch(() => {});
  let wins = await findWindows(driver, "Safari").catch(() => []);
  if (wins.length === 0 && opts.openForm) {
    try {
      await driver.ensureSession(agent);
      await driver.launchApp(agent, "com.apple.Safari", [FORM_URL]);
      for (let i = 0; i < 16 && wins.length === 0; i++) {
        await Bun.sleep(500);
        wins = await findWindows(driver, "Safari").catch(() => []);
      }
    } catch (e: any) {
      add("Safari window", false, `could not open Safari: ${e?.message ?? e}`);
      return checks;
    }
  }
  if (wins.length === 0) add("Safari window", false, "no Safari window (opening it needs `openForm`)");
  else if (wins.length > 1) add("Safari window", false, `${wins.length} Safari windows (${wins.map((w) => `"${w.title}"`).join(", ")}): close the extras, keyboard input is refused otherwise`);
  else {
    add("Safari window", true, `one window: "${wins[0]!.title}"`);
    const obs = await driver.observe(agent, wins[0]!);
    const items = perceive(obs);
    const onForm = pageIsClaimsForm(obs) && items.length >= 6;
    add("Claims form on screen", onForm, onForm ? `${items.length} controls readable (${obs.ms} ms)` : `Safari is not showing the claims form (${obs.degraded ?? "wrong page"}). Is the window on another Space or full-screen?`);
  }
  return checks;
}

if (import.meta.main) {
  const driver = new CliDriver();
  const checks = await runPreflight(driver, "Mint-3", { openForm: true });
  for (const c of checks) console.log(`${c.ok ? "✅" : c.fatal ? "❌" : "⚠️ "} ${c.name}: ${c.detail}`);
  await driver.endAll();
  process.exit(checks.some((c) => c.fatal && !c.ok) ? 1 : 0);
  void cua;
}
