# Integration notes (Mac ↔ Windows)

These notes are for merging this macOS build with the Windows version. Most of the engine is platform-neutral TypeScript. Only a thin layer talks to the operating system.

## What is portable and what is macOS-specific

| Module | Role | Platform |
|---|---|---|
| `src/contracts.ts` | All shared types: `Driver`, `Observation`, `Item`, `Decision`, `Task`, `LogLine`, … | **portable**: the contract both platforms implement |
| `src/loop.ts` | One agent, one task: observe → perceive → decide → gate → act → verify, plus escalation to the LLM | **portable** |
| `src/decide.ts` | `JevBrain` (TypeSafe), `LlmBrain` (Claude, for comparison), `ClaudeHelper` (LLM planner, writer, verifier) | **portable** |
| `src/jevhelper.ts` | jev-first helper: compilers, plan cache, jev verification, LLM only on demand | **portable** |
| `src/compile.ts` | Plan compilers: arithmetic, web search URLs, explicit text, folder sorting | portable logic. **The button labels are macOS Calculator's** ("All Clear", "Multiply", "Equals"); add Windows label aliases |
| `src/manager.ts` | Dispatcher (command → per-app tasks) and running agents in parallel | portable. `COMMON_APPS` and `APP_USES` list macOS app names; add the Windows ones |
| `src/llm.ts`, `src/logger.ts`, `src/server.ts`, `viewer/index.html`, `src/cli.ts`, `src/bench.ts` | Claude calls, JSONL logs, live panel, CLI, benchmark | **portable** (bench tasks name macOS apps) |
| `src/perceive.ts` | Accessibility elements → ≤40 ranked controls + screen text | portable logic, but **role names are macOS AX roles** (`AXButton`, `AXTextField`, …): see the mapping below |
| `src/driver.ts` | `CliDriver`: every action is a `cua-driver call …` subprocess (Cua Driver, macOS) | **macOS**: replace with a Windows driver |
| `src/apps.ts` | Find apps, open their window in the background, TextEdit scratch documents, open URLs | **macOS** (bundle ids, TextEdit, `launch_app`) |
| `src/fsops.ts` | Finder folder detection (path bar) + scripted, sandboxed file moves with an undo script | `finderFolder()` is **macOS**; `FileOps` / `safeRoot` are portable Node (check path separators) |
| `src/explain.ts` | Explain mode: capture on hotkey, Claude vision, snapping drawings to exact accessibility frames, lessons | portable logic; the screenshot comes from Cua's `get_desktop_state` (on Windows: any full-screen capture + the same frame list from UI Automation) |
| `overlay/Overlay.swift` | The on-screen overlay: hotkey, buddy, click-through drawing windows, speech in and out | **macOS** (AppKit). On Windows: a topmost transparent click-through window (WS_EX_LAYERED \| WS_EX_TRANSPARENT) that speaks the same small WebSocket protocol (`begin`, `ask`, `stop` → `status`, `answer`, `audio`/`speak` parts in order, `agents` (widget state), `clear`, `error`) |
| `src/router.ts` | The hotkey's words: a job for the agents, a question for explain mode, or "stop" (code rules, jev only when unclear) | **portable** |
| `src/results.ts` | Agents' answers made readable (widgets) and sayable (voice) | **portable** |
| `src/fastlane.ts`, `native/FastLane.swift` | The fast lane: clicks and native text inserts straight through accessibility (ms instead of ~0.6 s, truly parallel), Cua as the fallback | **macOS**. On Windows the same idea is UI Automation's `InvokePattern` / `ValuePattern` called directly; keep the fallback to the driver |
| `src/voice.ts` | ElevenLabs voice for explain mode: first sentence fetched separately, cache, prefetch, quota guard, falls back to the system voice | **portable** (plain `fetch`); the overlay plays the MP3 parts it is sent |

## The one interface to implement on Windows

A Windows driver only needs to implement `Driver` from `src/contracts.ts`:

```ts
interface Driver {
  ensureSession(agent); listWindows(); listApps(); launchApp(agent, appId, urls?);
  observe(agent, window, opts?);          // -> Observation { elements: AxElement[], markdown?, truncated, degraded?, ms }
  click(agent, window, token); typeText(agent, window, token, text, foreground?);
  pressKey(agent, window, "return" | "escape" | "tab", token?, foreground?);
  scroll(agent, window, "up" | "down", token?); confirm(agent, window, token); setValue(agent, window, token, value);
  endSession(agent);
}
```

* `token` is an opaque handle to one element of the latest observation. On Windows, this can be a UI Automation `RuntimeId`.
* `ActionResult.ok` means "not refused". Success is decided later by observing again and verifying.
* Everything above the driver (loop, jev, verification, panel) stays the same.

### Role mapping (UI Automation → the role names the engine uses)

| UIA ControlType | Use role | | UIA ControlType | Use role |
|---|---|---|---|---|
| Button / SplitButton | `AXButton` | | Hyperlink | `AXLink` |
| Edit (single line) | `AXTextField` | | ListItem / DataItem / TreeItem | `AXCell` |
| Document / multi-line Edit | `AXTextArea` | | Tab / TabItem | `AXTab` |
| CheckBox | `AXCheckBox` | | Slider | `AXSlider` |
| RadioButton | `AXRadioButton` | | Text | `AXStaticText` |
| ComboBox | `AXPopUpButton` (or `AXComboBox` if editable) | | Window | `AXWindow` (root), with children's `parent` set |
| MenuItem | `AXMenuItem` | | MenuBar | `AXMenuBar` (it gets excluded) |

Fill `label` from UIA `Name`, `value` from `ValuePattern.Value` (or `TogglePattern` state "1"/"0" for check and radio boxes), and `actions` from the supported patterns (`Invoke` → "AXPress", `ExpandCollapse` → "AXShowMenu").

## Things learned on macOS that probably matter on Windows too

* **Background input differs per app.** On macOS:
  * Cmd shortcuts, drags and keys to apps with two windows are refused in the background.
  * Electron text fields need a counted foreground fallback.
  * The loop already handles refusals: "refused" → foreground retry, counted in `task.counts.foreground`.
* **Only the verifier decides "done".** A driver saying "confirmed", or a value shown on screen, can be wrong (Reminders showed a date it never saved).
* **The LLM is on demand.** `HELPER=jev` (default): compilers, plan cache, jev. The LLM is called only when jev is stuck, a verdict is borderline, or text is creative. Every call is recorded in `task.llmCalls` with its reason.
* **Safety rules live in code**, not prompts:
  * never type into text the agent didn't write;
  * file moves are confined to one folder, with an undo script;
  * read the field back before pressing Enter;
  * no deletes.

## Running

```sh
bun install
cp .env.example .env     # TYPESAFE_API_KEY, ANTHROPIC_API_KEY
bash scripts/daemon.sh   # macOS: start the tuned Cua Driver daemon
bun run start            # panel on http://127.0.0.1:3000
bun test                 # engine tests on a simulated app (tests/sim-calc.ts shows how to fake a Driver)
bun run src/bench.ts --all   # benchmark: Haiku helper vs jev helper
```
