// Shared Playwright harness: a headless Chromium page that embeds the real Photopea
// (www.photopea.com) the same way our app does, through vendor/photopea/photopea.min.js.
//
// The host page is served by request interception at https://buddy.test/, so no
// local web server is needed. Evaluation only: never deployed, never used by the app.

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HOST = "https://buddy.test/";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export async function launch({ useProxy = true } = {}) {
  const opts = { headless: true };
  // Optional: a specific Chromium (for example a preinstalled one) and the HTTPS proxy, if the machine uses one.
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy && useProxy) opts.proxy = { server: proxy };
  return chromium.launch(opts);
}

function hostHtml(wrapperJs) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#222}#c{width:100vw;height:100vh}</style>
<script>${wrapperJs}</script></head><body><div id="c"></div>
<script>
window.harness = { ready: false, error: null };
Photopea.createEmbed(document.getElementById("c")).then(function (pea) {
  window.pea = pea; window.harness.ready = true;
}).catch(function (e) { window.harness.error = String(e); });
</script></body></html>`;
}

/**
 * Open a page with Photopea embedded full-viewport and `imagePath` opened as a document.
 * @returns {Promise<{ page, context, frame }>} frame = Photopea's iframe
 */
export async function openEditor(browser, { width, height, dpr = 1, imagePath }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const wrapper = await readFile(resolve(REPO, "vendor/photopea/photopea.min.js"), "utf8");
  await page.route(`${HOST}**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || path === "/host.html") {
      return route.fulfill({ status: 200, contentType: "text/html", body: hostHtml(wrapper) });
    }
    if (path.startsWith("/src/") && /^[\w/.-]+\.js$/.test(path) && !path.includes("..")) {
      // Our own browser modules, so probes run the exact code the app ships.
      return route.fulfill({ status: 200, contentType: "text/javascript", body: await readFile(resolve(REPO, `.${path}`), "utf8") });
    }
    if (path === "/sample" && imagePath) {
      return route.fulfill({
        status: 200, body: await readFile(imagePath),
        headers: { "Content-Type": MIME[extname(imagePath).toLowerCase()] || "application/octet-stream", "Access-Control-Allow-Origin": "*" },
      });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto(`${HOST}host.html`);
  await page.waitForFunction(() => window.harness.ready || window.harness.error, null, { timeout: 120_000 });
  const err = await page.evaluate(() => window.harness.error);
  if (err) throw new Error(`Photopea failed to start: ${err}`);
  if (imagePath) {
    await page.evaluate(async () => {
      const buf = await (await fetch("/sample")).arrayBuffer();
      await window.pea.loadAsset(buf);
    });
  }
  await page.waitForTimeout(1500); // let panels and thumbnails settle
  const frame = page.frames().find((f) => f.url().includes("photopea.com"));
  if (!frame) throw new Error("Photopea iframe not found");
  return { page, context, frame };
}

/** Run a Photopea script with a timeout (a script that throws never answers "done"). */
export async function runScript(page, script, timeoutMs = 8000) {
  return page.evaluate(
    async ({ script, timeoutMs }) => {
      const out = await Promise.race([
        window.pea.runScript(script),
        new Promise((r) => setTimeout(() => r(["TIMEOUT"]), timeoutMs)),
      ]);
      return out.map((x) => (typeof x === "string" ? x : `[${x?.constructor?.name} ${x?.byteLength ?? ""}]`));
    },
    { script, timeoutMs },
  );
}
