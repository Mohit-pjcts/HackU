// Probe: run our shipping step-check code (src/checks.js) against the real Photopea,
// driving the document through a cut-out task by script, and compare each check's
// answer with what we know is true. Prints a table; exits 1 on any mismatch.
//
// This turns the build guide's "VERIFY" items about Photopea scripting into a
// repeatable test instead of a claim.
//
// Usage: cd tools/autolabel && node probe.mjs --image ../../samples/photo.jpg

import { resolve } from "node:path";
import { launch, openEditor } from "./harness.mjs";

const i = process.argv.indexOf("--image");
const image = i > -1 ? resolve(process.argv[i + 1]) : null;
if (!image) {
  console.error("Usage: node probe.mjs --image path/to/photo.jpg");
  process.exit(1);
}

const browser = await launch();
let failures = 0;
try {
  const { page } = await openEditor(browser, { width: 1366, height: 768, imagePath: image });
  const rows = await page.evaluate(async () => {
    const checks = await import("/src/checks.js");
    const q = checks.createPeaQueue(window.pea, { timeoutMs: 6000 });
    const out = [];
    const before = await checks.snapshot(q, { pixels: true });
    const run = async (label, check, expected, ctx = {}) => {
      const r = await checks.runCheck(check, { q, before, ...ctx });
      out.push({ label, expected, got: r.status, method: r.method, detail: r.detail });
    };
    const script = (s) => q.runScript(`(function(){ try { ${s}; app.echoToOE("ok"); } catch (e) { app.echoToOE("ERR " + e); } })();`);

    out.push({ label: "facts at start", expected: "info", got: "info", method: "script", detail: JSON.stringify(before.facts) });
    await run("document is open", { type: "documentOpen" }, "done");
    await run("no selection yet", { type: "selection", expect: true }, "not_yet");
    await run("nothing changed yet", { type: "historyGrew" }, "not_yet");

    // Select a box around the middle of the photo (stands in for "select the subject").
    await script(`var d=app.activeDocument, w=d.width, h=d.height; d.selection.select([[w*0.25,h*0.2],[w*0.75,h*0.2],[w*0.75,h*0.95],[w*0.25,h*0.95]])`);
    await run("selection exists after selecting", { type: "selection", expect: true }, "done");
    await run("history grew after selecting", { type: "historyGrew" }, "done");
    await run("no transparency before removing background", { type: "transparency", minFraction: 0.1 }, "not_yet");

    // Remove the background: inverse + clear (the background layer is unlocked first).
    await script(`var d=app.activeDocument; d.activeLayer.isBackgroundLayer=false; d.selection.invert(); d.selection.clear(); d.selection.deselect()`);
    await run("background removed -> transparent pixels", { type: "transparency", minFraction: 0.1 }, "done");
    await run("corner is transparent", { type: "pixel", x: 0.02, y: 0.02, expect: "transparent" }, "done");
    await run("selection gone after deselect", { type: "selection", expect: false }, "done");
    await run("no new layer yet", { type: "layerCount", increasedBy: 1 }, "not_yet");

    // New coloured layer, filled, moved below the subject.
    await script(`var d=app.activeDocument; var n=d.artLayers.add(); n.name="Background colour"; var c=new SolidColor(); c.rgb.red=30; c.rgb.green=120; c.rgb.blue=220; d.selection.selectAll(); d.selection.fill(c); d.selection.deselect(); d.layers[0].move(d.layers[1], ElementPlacement.PLACEAFTER)`);
    await run("one more layer", { type: "layerCount", increasedBy: 1 }, "done");
    await run("a layer named like 'colour' exists", { type: "layerExists", nameMatches: "colou?r" }, "done");
    await run("corner is opaque again", { type: "pixel", x: 0.02, y: 0.02, expect: "opaque" }, "done");
    await run("corner colour changed from start", { type: "pixel", x: 0.02, y: 0.02, expect: "changed" }, "done");
    await run("composite has no transparency left", { type: "transparency", minFraction: 0.1 }, "not_yet");
    await run("canvas size unchanged", { type: "canvasSize", changed: true }, "not_yet");
    await run("combined check", { type: "all", checks: [{ type: "layerCount", min: 2 }, { type: "pixel", x: 0.02, y: 0.02, expect: "opaque" }] }, "done");

    // A script that throws: record what Photopea sends back, and make sure the queue keeps working.
    let thrownOut;
    try { thrownOut = await q.runScript("throw new Error('boom')"); } catch (e) { thrownOut = [`rejected: ${e.message}`]; }
    out.push({ label: "throwing script returns", expected: "info", got: "info", method: "queue", detail: JSON.stringify(thrownOut) });
    // An editor that never answers (we saw one script hang during testing): the queue must time out, not hang.
    const hung = checks.createPeaQueue({ runScript: () => new Promise(() => {}), exportImage: () => new Promise(() => {}) }, { timeoutMs: 1500 });
    const t0 = performance.now();
    let timedOut = false;
    try { await hung.runScript("x"); } catch { timedOut = true; }
    out.push({ label: "a silent editor times out instead of hanging", expected: "done", got: timedOut ? "done" : "not_yet", method: "queue", detail: `${Math.round(performance.now() - t0)} ms` });
    const r2 = await checks.runCheck({ type: "documentOpen" }, { q: hung, before });
    out.push({ label: "check on a silent editor says 'unknown'", expected: "unknown", got: r2.status, method: r2.method, detail: r2.detail });
    await run("the real editor still answers afterwards", { type: "documentOpen" }, "done");
    await run("model check without a frame source is 'unknown'", { type: "model", doneWhen: "x" }, "unknown");
    return out;
  });

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${pad("check", 52)} ${pad("expected", 9)} ${pad("got", 9)} ${pad("method", 8)} detail`);
  for (const r of rows) {
    const bad = r.expected !== "info" && r.expected !== r.got;
    if (bad) failures += 1;
    console.log(`${bad ? "✗" : "✓"} ${pad(r.label, 50)} ${pad(r.expected, 9)} ${pad(r.got, 9)} ${pad(r.method, 8)} ${r.detail}`);
  }
  console.log(failures ? `\n${failures} mismatch(es)` : "\nAll checks behaved as expected.");
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
