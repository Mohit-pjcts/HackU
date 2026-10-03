// Finding the app a task names, and the one window an agent will work in.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppInfo, Driver, AgentName, WindowRef } from "./contracts.ts";

const SCRATCH = join(import.meta.dir, "..", "scratch");

/** "calculator", "Calc", "safari browser" -> the installed app */
export function matchApp(apps: AppInfo[], name: string): AppInfo | null {
  const n = name.trim().toLowerCase().replace(/\.app$/, "");
  return (
    apps.find((a) => a.name.toLowerCase() === n) ??
    apps.find((a) => a.name.toLowerCase().startsWith(n)) ??
    apps.find((a) => n.includes(a.name.toLowerCase()) && a.name.length >= 4) ??
    apps.find((a) => a.name.toLowerCase().includes(n) && n.length >= 4) ??
    null
  );
}

export async function windowsOf(driver: Driver, appName: string): Promise<WindowRef[]> {
  const { windows } = await driver.listWindows();
  return windows
    // only windows the agent can actually read: not minimised, not on another desktop (Space)
    .filter((w) => w.app_name === appName && w.title && w.title.trim() !== "" && w.bounds.height > 100 && w.is_on_screen !== false && w.on_current_space !== false)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
    .map((w) => ({ pid: w.pid, windowId: w.window_id, app: appName, title: w.title }));
}

async function waitForWindow(driver: Driver, appName: string, pred: (w: WindowRef) => boolean, ms = 8000): Promise<WindowRef | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ws = (await windowsOf(driver, appName)).filter(pred);
    if (ws.length) return ws[0]!;
    await Bun.sleep(400);
  }
  return null;
}

/** un-minimise an app's minimised windows WITHOUT bringing it to the front (measured: the front app stays the same) */
export async function restoreMinimized(appName: string): Promise<boolean> {
  const p = Bun.spawn(["osascript", "-e", `tell application "System Events" to tell process ${JSON.stringify(appName)}
    set ws to (every window whose value of attribute "AXMinimized" is true)
    repeat with w in ws
      set value of attribute "AXMinimized" of w to false
    end repeat
    return count of ws
  end tell`], { stdout: "pipe", stderr: "ignore" });
  const n = Number((await new Response(p.stdout).text()).trim()) || 0;
  if (n) await Bun.sleep(900); // the restore animation
  return n > 0;
}

export async function frontApp(): Promise<string> {
  const p = Bun.spawn(["osascript", "-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}
async function activate(name: string) {
  if (!name) return;
  await Bun.spawn(["osascript", "-e", `tell application ${JSON.stringify(name)} to activate`], { stdout: "ignore", stderr: "ignore" }).exited;
}
const CHROMIUM = /chrome|brave|edge|arc|chromium|vivaldi|opera/i;

/**
 * open one or more URLs (space-separated) in a browser WITHOUT the keyboard (keys are often refused in background
 * browsers). newWindow: Chromium browsers get a fresh window with all URLs as tabs. If the browser grabs the front,
 * the previous app is put back in front and the step is counted as a foreground step.
 */
export async function openUrl(driver: Driver, agent: AgentName, app: AppInfo, url: string, newWindow = false): Promise<{ win: WindowRef; note?: string; tookFront?: boolean }> {
  const urls = url.split(/\s+/).filter(Boolean);
  // a folder path (Finder) or a web address
  const fix = (u: string) => (u.startsWith("~/") ? join(homedir(), u.slice(2)) : u.startsWith("/") || /^[a-z]+:\/\//i.test(u) ? u : `https://${u}`);
  const full = fix(urls[0] ?? url);
  const before = new Map((await windowsOf(driver, app.name)).map((w) => [w.windowId, w.title] as const));
  const wasFront = await frontApp();
  if (newWindow && CHROMIUM.test(app.name)) await driver.launchApp(agent, app.bundle_id, [], { newInstance: true, args: ["--new-window", ...urls.map(fix)] });
  else await driver.launchApp(agent, app.bundle_id, urls.map(fix));
  // a new window, or an existing one whose title changed (the URL opened in a tab there), or, for a folder, a window
  // already showing it (Finder just brings an existing window forward: no new window, no title change)
  const folder = full.startsWith("/") ? full.replace(/\/+$/, "").split("/").pop() : undefined;
  // an app's own link (maps://, stocks://) opens in its existing window, often without a title change: don't wait long
  const appLink = /^(maps|stocks):/i.test(full);
  const w = await waitForWindow(driver, app.name, (x) => !before.has(x.windowId) || before.get(x.windowId) !== x.title || (!!folder && x.title === folder), appLink ? 1500 : 6000);
  let all = await windowsOf(driver, app.name);
  if (!all.length && (await restoreMinimized(app.name))) all = await windowsOf(driver, app.name); // it opened in a minimised window
  const pick = w ?? (folder ? all.find((x) => x.title === folder) : undefined) ?? all[0];
  if (!pick) throw new Error(`${app.name} did not open ${full} in a window on this desktop (is it in full screen or on another desktop?)`);
  let tookFront = false;
  if (wasFront && wasFront !== app.name && (await frontApp()) === app.name) {
    tookFront = true;
    await activate(wasFront); // the browser stole the front: give it back
  }
  return { win: pick, tookFront, note: all.length > 1 ? `${app.name} has ${all.length} windows: background key presses may be refused` : undefined };
}

/**
 * The window an agent will work in. Apps are launched in the BACKGROUND (they do not come to the front).
 * Document apps (TextEdit) get a fresh scratch document so the agent never edits the user's own files.
 */
export async function prepareWindow(driver: Driver, agent: AgentName, app: AppInfo, url?: string): Promise<{ win: WindowRef; note?: string }> {
  if (app.name === "TextEdit") {
    mkdirSync(SCRATCH, { recursive: true });
    const file = join(SCRATCH, `${agent}-${Date.now()}.txt`);
    writeFileSync(file, "");
    const base = file.split("/").pop()!;
    await driver.launchApp(agent, app.bundle_id, [file]);
    const w = await waitForWindow(driver, app.name, (x) => x.title.includes(base.replace(/\.txt$/, "")));
    if (!w) throw new Error("TextEdit did not open the scratch document");
    return { win: w, note: `scratch document ${base}` };
  }
  if (url) return openUrl(driver, agent, app, url);
  let ws = await windowsOf(driver, app.name);
  let restored = false;
  if (ws.length === 0 && (await restoreMinimized(app.name))) { ws = await windowsOf(driver, app.name); restored = ws.length > 0; }
  if (ws.length === 0) {
    // no window on this desktop: launch it; an app that is already running (its windows closed, or all on another
    // desktop) needs a "reopen" (what clicking its Dock icon sends, here without bringing it to the front); a
    // Chromium browser with its windows on another desktop needs an explicit new window
    await driver.launchApp(agent, app.bundle_id);
    let w = await waitForWindow(driver, app.name, () => true, 3000);
    if (!w) {
      await Bun.spawn(["open", "-g", "-b", app.bundle_id], { stdout: "ignore", stderr: "ignore" }).exited;
      w = await waitForWindow(driver, app.name, () => true, 4000);
    }
    if (!w && CHROMIUM.test(app.name)) {
      await driver.launchApp(agent, app.bundle_id, [], { newInstance: true, args: ["--new-window"] });
      w = await waitForWindow(driver, app.name, () => true, 5000);
    }
    if (!w) throw new Error(`${app.name} opened no window on this desktop (is it in full screen or on another desktop?)`);
    ws = [w];
  }
  const note = [restored ? `restored a minimised ${app.name} window` : "", ws.length > 1 ? `${app.name} has ${ws.length} windows; using "${ws[0]!.title}"` : ""].filter(Boolean).join("; ");
  return { win: ws[0]!, note: note || undefined };
}
