# Claims Agent

A **background agent for macOS** that enters a batch of reimbursement claims into a web form in a **Safari window behind your other windows**, while you keep working. It **proves** each claim landed, and lists what it **could not** do and why.

> Every agent says "done". This one shows proof for each item, plus the items it didn't do and the reason.

The barrier it targets is **cost**: a cheap text classifier makes every decision, instead of a frontier vision model reading screenshots.

## What it does

```
claims you type ──► rules in code (mandate cap, duplicates, readable dates)
                        │ refused early ──► exceptions list (with a reason)
                        ▼
   agent "Mint-3" works in background Safari, one step at a time:
     observe (accessibility tree, as text) → TypeSafe jev picks kind / control / value
     → confidence gate (< 0.4 escalates, never guesses) → fill a field
     → read every field back → only then press Submit
                        ▼
   ORACLE: the form's own database must hold exactly one new, matching record
                        ▼
   report: verified (with proof)  |  exception (with reason)  |  nothing silent
```

* The cursor is Cua Driver's coloured session cursor ("Mint-3"). Your own mouse and keyboard stay yours; Safari never becomes the front app.
* **jev never writes text.** It chooses *which control* gets *which claim value*; the value itself always comes from the confirmed claim.
* **Only the oracle decides "done".** `effect: confirmed` from the driver and the on-screen value can both lie (measured), so neither is trusted.

## Run it

Requirements: macOS 14+, [Bun](https://bun.sh) 1.4+, [Cua Driver](https://github.com/trycua/cua) **0.32.0** with Accessibility and Screen Recording granted to `CuaDriver.app`.

```sh
bun install
cp .env.example .env            # add TYPESAFE_API_KEY (and optionally ANTHROPIC_API_KEY)
bash scripts/daemon.sh          # (re)starts the Cua daemon tuned: 300 ms window-change timeout
bun run preflight               # checks everything and opens the form in Safari
bun run start                   # form on :8765, live panel on :3000
```

Open <http://127.0.0.1:3000>, press **Load demo batch**, then **Run batch**.

Headless alternative: `bun run src/cli.ts` (add `--policy` to force the offline classifier, `--only 2` for two claims).

**Without a TypeSafe key** the agent runs on an **offline rule-based policy**. It is labelled everywhere: a red banner in the panel, `backend: "policy"` in every log line. It is not jev.

**After granting permissions the daemon must be restarted** (`bash scripts/daemon.sh`), otherwise every call returns `permissions_pending`.

## Tests

```sh
bun test           # 23 tests
bun run typecheck
```

The loop is tested against a simulated Safari (`tests/sim-driver.ts`) that reproduces the behaviours measured on a real Mac, including the nasty ones: typing *appends* instead of replacing, element tokens die with the next snapshot, drop-downs need click → Escape → type-ahead. Injected faults prove the guards: silently dropped typing, corrupted values, a classifier that says "done" too early, a classifier that presses Submit on an empty form.

## What was measured live (booth Mac, macOS 26, Cua Driver 0.32.0)

| | |
|---|---|
| A claim, end to end (8 form actions, background Safari) | about 12–15 s |
| One AX click, tuned daemon | about 0.6 s (2.3–2.6 s with defaults) |
| One accessibility snapshot of Safari | 0.2–0.6 s |
| 6-claim demo batch (4 verified, 2 exceptions) | 55 s |
| Front-app changes caused by the agent | none (Safari never became frontmost) |

## Known limits (honest list)

* **TypeSafe jev has not been run against the real API yet** (no key at build time). The request/response handling is tested against a fake server only. Run `agents-research/live-gates/g4-typesafe.ts` first.
* The destination is our own **replica** of a claims form, labelled as such. Real forms (for example Google Forms) use custom drop-downs that this adapter does not handle.
* macOS only; one Safari window with the form, on any Space. Close other Safari windows: keyboard input is refused when an app has two.
* A human typing in another app *while* the agent types into Safari has not been tested.
* Natural-language dates are limited: "last Fri" is refused on purpose (which Friday?). Cantonese words for weekdays and amounts are parsed; voice intake is not in this prototype.
* The agent is a single worker. Cua serialises physical input across all agents, so more agents would not be faster (measured: 1.25 actions/s with two).

## Layout

```
src/contracts.ts            all shared types
src/driver.ts               `cua-driver call <tool> '<json>'`, one subprocess per call; revives dead sessions
src/perceive.ts             accessibility elements -> ≤30 numbered items (web page only, never browser chrome)
src/adapters/claims-form.ts the form's fields, per-control recipes, read-back, and the ORACLE client
src/decide.ts               TypeSafe jev (kind / item / field), offline policy, confidence gate
src/loop.ts                 one claim: observe → decide → act → guard → submit → oracle
src/batch.ts                rules in code (mandate, duplicates), exceptions, report
src/parse.ts                typed text -> claim (day/month dates, English + Cantonese)
src/server.ts, viewer/      live panel (server-sent events) and its page
replica/                    the claims form + its database
scripts/daemon.sh           restart the Cua daemon with the tuned setting
tests/                      unit + simulated-Safari loop tests
```

## Credits

* **awlevin/typesafe-computer-use** (MIT): the decision-loop design (read the screen as text, ask a classifier, gate on confidence).
* **Cua Driver** by trycua (MIT): background clicks and typing on macOS, and the per-agent coloured cursors.
* **TypeSafe jev** (`@typesafe-ai/sdk`): the classifier.
* Bun, TypeScript.

