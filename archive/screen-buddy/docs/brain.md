# The brain: pointing, step checks, safety (Person B)

Written Fri 2 – Sat 3 Oct 2026. This is the server function, the three pointing modes, the step checks, the abuse limits and the evaluation tools. It follows `clicky-build-guide.md` sections 2, 3 (Stages 5 and 6), 4.4 and 4.5.

Everything here runs without an API key in **mock mode**, so the front end can be built against it tonight.

```
 page (Person A)                         server (Vercel function)                   Anthropic API
 ───────────────                         ────────────────────────                   ─────────────
 capture frame ──► src/modes.js           api/step.js ─► lib/pipeline.js
                   resize to the model's     method, access code, body size
                   pixel budget              validate (zod) every field
                   (grid: draw grid)         check real image type and size
                   (refine: crop + zoom)     check the model's pixel budget
                   POST /api/step ─────────► rate limit, session cap, global cap ──► Claude (JSON schema
                                             prompt + image ─────────────────────────  structured output)
                   ◄──── say, target ──────  validate the answer, confidence floor ◄─
 ring + voice  ◄── map to page pixels        log sizes, tokens, cost, latency (no image, no words)

 after the step ──► src/checks.js ──► Photopea scripts (layers, selection, history)
                                    └► exported PNG measured in the page (transparency, colour)
                                    └► POST /api/verify (model-checked fallback)
```

## 1. Run it

```bash
npm install
npm run dev:mock      # fake model, no key, no cost  -> http://localhost:3000
npm test              # 40 unit and API tests
```

Open `http://localhost:3000/tools/brain-lab.html`, pick the five files in `tools/fixtures/` (four screenshots and `labels.json`), and press **Run on this image**.

With a real key: copy `.env.example` to `.env`, set `ANTHROPIC_API_KEY` (and optionally `MODEL_NAME`, `ALLOWED_MODELS`), then `npm run dev`. On Vercel, set the same variables under Project → Settings → Environment Variables. Nothing else is needed: `vercel.json` sets the function timeout and the CORS header for `/samples/`.

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Server only. Never sent to the browser, never logged. |
| `MODEL_NAME` | `claude-sonnet-5-5` | Default model. |
| `ALLOWED_MODELS` | the default model | Extra models a request may ask for (the bake-off), comma-separated. |
| `MODEL_EFFORT` | `low` | Adaptive-thinking effort. Low keeps pointing fast. Set empty to use the model's default. |
| `MOCK_MODEL` | off | `1` = fake answers, no API calls. |
| `CONFIDENCE_FLOOR` | `0.5` | Below this, no pointer: the buddy says it is not sure. Tune it with the sweep in the lab. |
| `RATE_LIMIT_PER_MINUTE` | 20 | Per visitor. |
| `MAX_CALLS_PER_SESSION` | 80 | Per page session. |
| `GLOBAL_CALLS_PER_HOUR` | 600 | Per server instance. |
| `JUDGE_ACCESS_CODE` | none | If set, every request needs header `x-access-code`. |
| `MODEL_TIMEOUT_MS`, `MODEL_MAX_TOKENS`, `IMAGE_TIER`, `MODEL_THINKING` | 25000, 2000, auto, unset | Escape hatches; rarely needed. |

## 2. For Person A: using it from the page

```js
import { locate, newSessionId, onUpload, verifyStep } from "./modes.js";
import { frameToClient } from "./shared/geometry.js";
import { createPeaQueue, snapshot, runCheck } from "./checks.js";

const sessionId = newSessionId();
onUpload((u) => flashCaptureIndicator(u));        // every image that leaves the device, with its size

// frame = a canvas (or ImageBitmap / <video>) holding the captured tab, at full resolution
const r = await locate({ frame, step, transcript, mode: "refine", sessionId, history });
speak(r.say);                                     // always present, also on errors (err.say)
if (r.framePoint) {
  const rect = { left: 0, top: 0, width: innerWidth, height: innerHeight }; // what the frame shows
  drawRing(frameToClient(r.framePoint, r.frameSize.width, r.frameSize.height, rect));
}
```

- `locate()` resizes the frame for the model, draws the grid or does the zoomed second pass, calls `/api/step`, and returns points in **frame pixels**. `frameToClient()` converts to CSS pixels from measured sizes, so device pixel ratio and browser zoom are handled.
- Hide your own overlay before grabbing the frame (guide 4.2). `locate()` cannot do that for you.
- Errors throw `BrainError` with `code` and a speakable `say`. `RATE_LIMITED` carries `retryAfterSec`.
- `r.modelGuess` is the model's position even when it refused to point. It is for evaluation only. Never draw it.

Step checks (after the user says "done", or after a pause):

```js
const q = createPeaQueue(pea);                 // pea = the photopea.js embed object
let before = await snapshot(q, { pixels: true }); // at the start of each step
const v = await runCheck(step.check, { q, before, step, sessionId, captureFrame });
// v.status: "done" | "not_yet" | "unknown";  v.method: "script" | "pixels" | "model" | "manual"
```

## 3. The contract

The agreed request and response from guide section 2 are unchanged. The fields below marked *added* are optional or extra, so code written against the original contract still works.

**`POST /api/step` request**

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string, 8–100 chars, `[A-Za-z0-9_-]` | |
| `stepId`, `stepGoal`, `targetHint` | strings (80 / 400 / 400 chars) | |
| `transcript` | string, up to 600 chars | Quoted to the model as data, never as instructions. |
| `imageBase64` | JPEG or PNG, no `data:` prefix, under 4.4 MB | The server reads the real size from the file header. |
| `imageWidth`, `imageHeight` | integers | Must match the file, or 400 `IMAGE_SIZE_MISMATCH`. |
| `mode` | `direct` \| `grid` \| `refine` | |
| `history` | up to 40 `{stepId, status}` | |
| `cropOffsetX`, `cropOffsetY`, `cropScale` | numbers | Required in refine mode. Crop pixel (x, y) = frame pixel (offsetX + x / scale, offsetY + y / scale). |
| `gridCols`, `gridRows` | *added*, integers | Grid size drawn on the image (default 12 x 8). |
| `commonMistakes` | *added*, up to 6 strings | From `steps.json`; helps the model spot an off-track user. |
| `model` | *added* | Must be in `ALLOWED_MODELS` (the bake-off). |

**Response (200)**: `ok`, `say`, `target` ({x, y} in the sent image's pixels, or null), `confidence`, `cannotTell`, `usage` ({inputTokens, outputTokens}), `latencyMs`, plus *added*: `targetBox` (the element's box), `offTrack`, `observation`, `reason` (why it can't tell: `model_says_not_visible`, `below_confidence_floor`, `invalid_box`, `invalid_cell`, `unparseable_model_output`), `modelTarget` / `modelBox` (the raw guess, for evaluation), `mode`, `image`, `model`, `mock`, `costUsd`, `pricesReadOn`, `modelLatencyMs`, `stopReason`, `callsLeft`, `received` (the receipt of what reached the server: bytes, size, transcript length, `stored: false`). In refine mode also `crop`, `frameTarget`, `frameBox` (already converted to frame pixels).

**Errors** always look like `{ ok: false, error: { code, message }, say }`, so the buddy always has something to say.

| Status | Code | When |
|---|---|---|
| 400 | `BAD_REQUEST` (+ `issues`), `BAD_JSON`, `BAD_IMAGE`, `BAD_IMAGE_TYPE`, `IMAGE_SIZE_MISMATCH`, `IMAGE_TOO_LARGE` (+ `imageBudget`), `MODEL_NOT_ALLOWED`, `IMAGE_REJECTED` | Bad input. No model call is made. |
| 401 | `ACCESS_CODE` | `JUDGE_ACCESS_CODE` is set and the header is missing or wrong. |
| 413 | `BODY_TOO_LARGE` | Over 4.5 MB. |
| 429 | `RATE_LIMITED`, `GLOBAL_CAP`, `SESSION_CAP` | With `Retry-After` where it applies. |
| 500 | `NO_API_KEY`, `INTERNAL` | Server not configured / unexpected. |
| 502–504 | `MODEL_AUTH`, `MODEL_NOT_FOUND`, `MODEL_ERROR`, `MODEL_RATE_LIMITED`, `MODEL_BUSY`, `MODEL_TIMEOUT` | Provider problems. |

**`POST /api/verify`**: `{ sessionId, stepId, stepGoal, doneWhen, imageBase64, imageWidth, imageHeight, model? }` → `{ ok, done: true | false | null, say, confidence, observation, usage, costUsd, ... }`. Used only for "model-checked" steps.

**`GET /api/health`**: model, whether a key is configured (not the key), allowed models, each model's image budget, limits, confidence floor, and the price table with the date it was read.

## 4. The three pointing modes

| Mode | What is sent | What the model returns | Calls |
|---|---|---|---|
| `direct` | The frame, resized to fit the model's budget | Bounding box `[x1, y1, x2, y2]` of the target; we use its centre | 1 |
| `grid` | The same frame with a 12 x 8 labelled grid drawn on it | Cell (`C5`) and one of 9 positions in it (so `targetBox` is that ninth of the cell) | 1 |
| `refine` | Pass 1 (direct or grid), then a crop of the **full-resolution** frame around that point, zoomed up to 3x | Box inside the crop | 2 |

Design choices, and why:

- **Boxes, not points.** Anthropic's coordinate docs show box prompts; a box also lets the ring match the element's size. We ask for pixels, never 0–1 values, which the docs say work poorly.
- **No silent resizing.** Claude shrinks large images and then answers in the shrunk image's pixels. `src/shared/budget.js` resizes on the page to fit the model's tier (high tier: 2,576 px long edge and 4,784 tokens of 28 x 28 px; standard: 1,568 / 1,568), and the server sets `transformations.oversized_image = "error"` and re-checks the budget, so a mistake fails loudly instead of shifting every coordinate.
- **Structured outputs instead of a forced tool call** (a change from guide 4.4). Opus 5.5 and Fable 5.1 have adaptive thinking always on and Sonnet 5.5 has it on by default. Anthropic's structured-outputs page says JSON-schema output works with thinking and with images, so one code path serves every model in the bake-off. We still validate the JSON with zod: anything malformed becomes "I can't tell".
- **Refine keeps low-confidence first guesses.** If pass 1 found something but was unsure, pass 2 zooms in to confirm. If pass 1 saw nothing, there is nothing to zoom into.
- **Grid labels cover a little of the screen** (for example the corner of the File menu). That is part of the trade-off the comparison measures.

## 5. Safety and trust

- **Advise only.** Scripts sent to Photopea only read state. Nothing clicks or edits for the user.
- **"I can't tell" is a first-class answer.** The prompt asks for it when the target is not visible; the server also refuses to point when the answer is malformed, the box is outside the image, the grid cell does not exist, or confidence is under `CONFIDENCE_FLOOR`. In that last case the buddy says it is not sure and gives its guess in words, with no ring.
- **Prompt injection.** The user's words are passed as a quoted string; the system prompt says text inside the screenshot (including ads) and the user's words cannot change the rules. The model has no tools, and its output is held to a schema, so the worst case is a wrong sentence, not an action.
- **What leaves the device:** the JPEG of the shared tab (or the zoomed crop) and the transcript text, only when the user asks. `onUpload()` lists each one for the "capture sent" indicator and the local upload log. The server keeps nothing: it logs one line per call with sizes, tokens, cost, latency, outcome and a 10-character hash of the session id. No image, no words, no IP.
- **Limits, honestly described.** Per-visitor rate limit, per-session cap and a global hourly cap live in the memory of one server instance. They stop a casual flood and our own bugs, not a determined attacker (a new session id resets the session cap; counters reset on cold start). The real backstops are the spend limit in the Anthropic Console and `JUDGE_ACCESS_CODE` when the link is public.

## 6. Step checks, and what we verified

Check spec, for the `check` field of each step in `steps.json` (Person C):

```jsonc
{ "type": "documentOpen" }
{ "type": "selection", "expect": true }                    // false = nothing selected
{ "type": "layerCount", "increasedBy": 1 }                 // or "min" / "max"
{ "type": "layerExists", "nameMatches": "colou?r" }
{ "type": "historyGrew" }                                  // the user changed something
{ "type": "canvasSize", "changed": true }                  // or "width" / "height"
{ "type": "transparency", "minFraction": 0.1 }             // background removed
{ "type": "pixel", "x": 0.02, "y": 0.02, "expect": "opaque" }  // or "transparent" / "changed"
{ "type": "model", "doneWhen": "The export dialog is open with PNG chosen" }
{ "type": "manual" }
{ "type": "all", "checks": [ ... ] }
```

`tools/autolabel/probe.mjs` runs `src/checks.js` itself against the real Photopea in headless Chromium, driving a cut-out by script (select, inverse, clear, new filled layer, move it below). Result on 2–3 Oct 2026: **all 21 probes behaved as expected.** What that established:

| Fact | Result |
|---|---|
| Document count, size, layer names / visibility / opacity / order | Work |
| "Is there a selection?" | Works: `selection.bounds` throws when there is none |
| History length | Works (step names come back empty) |
| Exported PNG with real transparency | Works: 62% transparent after clearing the background |
| Current tool (`app.currentTool`) | **Not exposed**: tool-choice steps need a model check or "manual" |
| Background-layer flag, layer masks | Not reliable / not found: use pixel checks instead |
| A script that hangs | Seen once while probing. Every call goes through a queue with a timeout; a silent editor gives `unknown`, not a frozen buddy |

The agreement between each check and a human observer is still to be measured in the trials: `recordAgreement()` and `agreementSummary()` in `checks.js` collect it.

## 7. Evaluation (the core evidence)

1. **Auto-labelled set.** `tools/autolabel/autolabel.mjs` opens the real Photopea at several window sizes and pixel ratios, takes the screenshots tab capture would send, and reads the true box of 20 controls (tools, layer buttons, menus, menu items) from Photopea's own page. One run with three photos x four window sizes x three screen states gives over 200 labelled targets in a few minutes. Screenshots are split into a tune half and a report half by file, so the halves never share an image.
2. **Hand-labelled real screens.** Screenshots from real trial sessions, labelled in the Brain Lab (draw the box, export `labels.json`). Report these separately: they include the messy states scripted runs do not.
3. **Run.** In the Brain Lab, or headless: `node tools/autolabel/eval.mjs --dir out --split report`. Every batch also includes a blank and an unrelated screen, where the right answer is "I can't tell". It reports per mode: hit rate, wrong-but-confident rate, "can't tell" rate, precision when pointing, raw hit rate without the floor, median latency, calls and cost per answer, and a confidence-floor sweep (coverage vs precision).
4. **Bake-off.** Put both models in `ALLOWED_MODELS` and pass `--model`. Same images, same prompt.
5. **Rules.** Tune prompts and the floor on the tune half only. Every number in the README comes from these files, with the date.

```bash
cd tools/autolabel && npm install && npx playwright install chromium
node autolabel.mjs --images ../../samples/photo1.jpg,../../samples/photo2.jpg --sizes 1280x720,1366x768,1536x864,1920x1080 --dpr 1,2
node probe.mjs --image ../../samples/photo1.jpg
node eval.mjs --dir out --split tune --modes direct,grid,refine        # needs the dev server running
```

## 8. Photopea facts for the step list (Person C)

Seen in our headless runs on 2 Oct; check them in the real UI before writing `steps.json`:

- The **Select** menu has *Subject*, *Remove BG* and *Magic Cut...*. *Subject*, *Remove BG* and *Inverse* were greyed out on a fresh document (Inverse needs a selection; Remove BG needs a third-party key per Photopea's API page).
- At 768 px tall the left toolbar is shorter: the Lasso tool was not visible on its own.
- In most runs at 1366 px wide and up, a "Support Photopea" panel took a column on the right (not in every run). The prompt tells the model to ignore it.
- Layer buttons (New Layer, Add Raster Mask, Delete) sit at the bottom of the Layers panel and are about 19 x 22 px: the smallest targets in the task.

## 9. Not done yet / known limits

- **No accuracy numbers yet.** Nothing has been run against the real model (no key in this environment). The first job with a key: run `eval.mjs` on the tune half for all three modes and both models.
- Prices are from Anthropic's model page read on 2 Oct 2026; `costUsd` is null for a model not in `lib/pricing.js`. Thinking tokens are billed as output and are included.
- Self-reported confidence from a language model is often poorly calibrated. The sweep shows how much the floor actually buys; refine's `agreementPx` (how far pass 2 moved the point) is a second signal worth reporting.
- The limits are per server instance (see section 5).
- The grid's labels can hide small parts of the screen.
- Chrome only for capture and speech (Person A's part), as the guide says.
