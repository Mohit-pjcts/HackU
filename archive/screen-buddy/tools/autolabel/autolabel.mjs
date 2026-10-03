// Build an auto-labelled screenshot set for the pointing evaluation.
//
// For each sample image x window size x pixel ratio x screen state, open the real
// Photopea in headless Chromium, take a screenshot (what tab capture would send),
// and record the true on-screen box of every target in targets.mjs, read from
// Photopea's own page structure. Output: out/<name>.png + out/labels.json in the
// format the Brain Lab loads.
//
// Honest limits: these are scripted states, not real user sessions. They test
// "can the model find this control at this size", not "does the buddy follow a
// confused user". Hand-label real trial screenshots too, and report them apart.
//
// Usage:
//   cd tools/autolabel && npm install && npx playwright install chromium
//   node autolabel.mjs --images ../../samples/a.jpg,../../samples/b.jpg [--sizes 1366x768,1920x1080] [--dpr 1,2] [--out out]

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { launch, openEditor } from "./harness.mjs";
import { TARGETS } from "./targets.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const images = arg("images", "").split(",").map((s) => s.trim()).filter(Boolean).map((p) => resolve(p));
const sizes = arg("sizes", "1280x720,1366x768,1536x864,1920x1080").split(",").map((s) => s.split("x").map(Number));
const dprs = arg("dpr", "1").split(",").map(Number);
const outDir = resolve(arg("out", "out"));
const states = arg("states", "default,menu-select,menu-file").split(",");

if (!images.length) {
  console.error("Pass at least one sample image: --images path/to/photo.jpg[,more.jpg]");
  process.exit(1);
}

const STATES = {
  default: async () => {},
  "menu-select": async (frame) => frame.locator("button", { hasText: /^Select$/ }).first().click(),
  "menu-file": async (frame) => frame.locator("button", { hasText: /^File$/ }).first().click(),
};

/** True on-screen box of a target, in CSS pixels of the page, or null if not visible. */
async function findBox(frame, locate) {
  return frame.evaluate((loc) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && st.visibility !== "hidden" && st.display !== "none" && r.bottom > 0 && r.right > 0 &&
        r.top < innerHeight && r.left < innerWidth;
    };
    let el = null;
    if (loc.title) {
      const all = Array.from(document.querySelectorAll("[title]")).filter(visible);
      el = all.find((e) => e.getAttribute("title") === loc.title) ||
        all.find((e) => e.getAttribute("title").startsWith(`${loc.title} `));
    } else if (loc.menu) {
      el = Array.from(document.querySelectorAll("button")).filter(visible).find((e) => e.textContent.trim() === loc.menu && e.getBoundingClientRect().top < 40);
    } else if (loc.menuItem) {
      const label = Array.from(document.querySelectorAll("span.label")).filter(visible).find((e) => e.textContent.trim() === loc.menuItem);
      // Skip greyed-out rows (class "disab"): pointing at a disabled item is not a useful test.
      el = label && !label.parentElement.classList.contains("disab") ? label.parentElement : null;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // Clip to the viewport: a half-hidden control is labelled by its visible part.
    const x1 = Math.max(0, r.left);
    const y1 = Math.max(0, r.top);
    const x2 = Math.min(innerWidth, r.right);
    const y2 = Math.min(innerHeight, r.bottom);
    return x2 - x1 > 2 && y2 - y1 > 2 ? [x1, y1, x2, y2] : null;
  }, locate);
}

// The iframe fills the viewport at (0, 0); still, add its offset in case the host page changes.
async function frameOffset(page) {
  return page.evaluate(() => {
    const f = document.querySelector("iframe");
    const r = f ? f.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: r.left, y: r.top };
  });
}

function splitFor(name) {
  // Split by screenshot, not by item, so the two halves never share an image.
  return createHash("sha256").update(name).digest()[0] % 2 === 0 ? "tune" : "report";
}

const browser = await launch();
await mkdir(outDir, { recursive: true });
const items = [];
let shots = 0;
try {
  for (const img of images) {
    const imgTag = basename(img, extname(img)).replace(/[^A-Za-z0-9_-]/g, "");
    for (const [w, h] of sizes) {
      for (const dpr of dprs) {
        const { page, context, frame } = await openEditor(browser, { width: w, height: h, dpr, imagePath: img });
        try {
          for (const state of states) {
            await page.keyboard.press("Escape").catch(() => {});
            await page.mouse.click(Math.round(w * 0.45), Math.round(h * 0.9)).catch(() => {}); // close any menu
            await page.waitForTimeout(300);
            await STATES[state](frame);
            await page.waitForTimeout(500);
            const name = `${imgTag}-${w}x${h}@${dpr}x-${state}.png`;
            await page.screenshot({ path: resolve(outDir, name) });
            shots += 1;
            const off = await frameOffset(page);
            const split = splitFor(name);
            for (const t of TARGETS.filter((t) => t.state === state)) {
              const b = await findBox(frame, t.locate);
              if (!b) continue;
              const box = [b[0] + off.x, b[1] + off.y, b[2] + off.x, b[3] + off.y].map((v) => Math.round(v * dpr));
              items.push({
                file: name, stepId: t.id, stepGoal: t.goal, targetHint: t.hint, transcript: "where do I click?",
                box, split, source: "autolabel",
                meta: { image: basename(img), viewport: `${w}x${h}`, dpr, state },
              });
            }
            console.log(`${name}: ${items.filter((i) => i.file === name).length} targets`);
          }
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}

const labels = { version: 1, createdAt: new Date().toISOString(), generator: "tools/autolabel/autolabel.mjs", items };
await writeFile(resolve(outDir, "labels.json"), JSON.stringify(labels, null, 2));
const bySplit = items.reduce((a, i) => ((a[i.split] = (a[i.split] || 0) + 1), a), {});
console.log(`\n${shots} screenshots, ${items.length} labelled targets (${JSON.stringify(bySplit)}) -> ${outDir}`);
