// Picks the one real window of an app. `list_windows` also returns ghost windows (empty title, 1800x39),
// windows of other apps' helpers, and windows on other Spaces, so we filter hard and demand exactly one.
import type { Driver, WindowRef } from "./contracts.ts";

export async function findWindows(driver: Driver, appName: string): Promise<WindowRef[]> {
  const { windows } = await driver.listWindows();
  return windows
    .filter((w) => w.app_name === appName && w.title && w.title.trim() !== "" && w.bounds.height > 100)
    .map((w) => ({ pid: w.pid, windowId: w.window_id, app: appName, title: w.title }));
}

export async function pickWindow(driver: Driver, appName: string): Promise<WindowRef> {
  const ws = await findWindows(driver, appName);
  if (ws.length === 0) throw new Error(`No ${appName} window found. Open one on the claims form.`);
  if (ws.length > 1) {
    throw new Error(
      `Found ${ws.length} ${appName} windows (${ws.map((w) => `"${w.title}"`).join(", ")}). ` +
        `Keyboard input is refused when an app has more than one window: close the extras.`,
    );
  }
  return ws[0]!;
}
