# Backstage

**Tell your computer what to do, and coloured AI agents do it inside your real apps, in background windows, while you keep working. Or ask about anything on your screen, and it answers out loud while it draws on your screen to show you.**

Each step is decided by **TypeSafe jev**, a small calibrated classifier (about 0.6 s and $0.00008 per decision), not by a large language model. An LLM (Claude) is called only where it is genuinely needed: open-ended planning, writing text, a borderline check, and explain mode's picture of the screen. When jev isn't sure, the agent stops and says why instead of guessing.

This repository holds the two engines of the same product, each tested live on its own platform:

| | **macOS** ([`mac/`](mac)) | **Windows** ([`windows/`](windows)) |
|---|---|---|
| Start | `bash start.sh` (or `bash start.sh --record` to record a demo) | `powershell -ExecutionPolicy Bypass -File start.ps1` |
| Hotkey | hold **Control + Option** to talk, tap to type | hold **Ctrl + Win** to talk, tap to type |
| Reads apps through | the macOS accessibility tree (Cua Driver) | UI Automation (Cua Driver) |
| Fast lane (actions in milliseconds, truly parallel) | direct accessibility presses and text inserts (`mac/native/FastLane.swift`) | UI Automation Invoke / Toggle / Select / Value (`windows/native/win/fastlane.ps1`) |
| Overlay (cursors, drawings, widgets) | native Swift app (`mac/overlay/Overlay.swift`) | PowerShell / WPF (`windows/native/win/overlay.ps1`) |
| Speech to text | on-device macOS speech recognition | faster-whisper, local (`windows/native/win/voice.py`) |
| Voice | ElevenLabs (falls back to the Mac voice) | ElevenLabs (falls back to the Windows voice) |
| Tests | `cd mac && bun test` (25) | `cd windows && bun test` (135 + 1 skipped) |
| Details | [mac/README.md](mac/README.md) | [windows/README.md](windows/README.md) |

Both engines share the same design: one hotkey for everything, a router that tells a job from a question, one coloured agent per part of the job, a fast lane with Cua Driver as the safe fallback, live widgets, explain mode with lessons, and the same voice. The Windows engine was built after the Mac one and follows its design, colours, router, explain mode, voice and fast lane.

## How it works

```
voice / typed ──► router ──► DO ──► dispatcher ──► agent A, agent B, agent C … (in parallel, one window each)
   (hotkey)        │                    (code in ~0 ms; jev only when no app is named)
                   └────► EXPLAIN ──► 1 screenshot + the window's controls ──► Claude (vision) ──► overlay + voice

each agent, each step (max 25):
  OBSERVE the window as text ─► PERCEIVE the 40 most relevant controls ─► DECIDE (jev, ~0.6 s)
  ─► GATE (confidence below 0.4: don't act; re-plan once, else stop and say why)
  ─► ACT (fast lane in milliseconds, or Cua ~0.6 s) ─► VERIFY ("done?" vs the starting snapshot: code first, jev, LLM only if borderline)
```

Common tasks have **skills**: plans built in code before the loop (Calculator keys, a search URL, a maps route, a file sort with an undo script, writing a Word document). Everything else goes through the general loop above.

## What each engine does

| Feature | macOS | Windows |
|---|---|---|
| One command, several agents at once (one per app; up to 9), each with a widget and a live preview of its window | ✅ | ✅ |
| Agent cursors that fly to every action, visible in the widgets and in screen recordings | ✅ (`--record`) | widgets and rings |
| Explain mode: rings, boxes, circles, arrows, underlines, labels on the real controls; "how do I…" lessons | ✅ (Option + → / ←, Esc) | ✅ (Alt + → / ←, Esc) |
| Messaging (search the contact, the right box for the name and the text, send only when asked, only to the named chat) | ✅ (general logic, tested on WhatsApp) | ✅ |
| Calculator, web answers, Word documents, file sorting with Undo | ✅ | ✅ |
| Maps routes, stock prices, weather | Apple Maps, Stocks, Weather apps | Google Maps, Google Finance, wttr.in |
| Multi-step jobs where a later part uses an earlier result ("find X then write it in Notepad") | | ✅ |
| Several jobs at once, each with its own Stop | | ✅ |
| Approval before irreversible clicks (send, pay, delete…); never types into password or card fields | sending only when asked | ✅ |
| Flights (to the page before payment), launching games, finding folders by name | | ✅ |
| Replay a past run, compare jev with an LLM on the same plan, benchmark with independent checks | compare + benchmark | replay |

## Measured (macOS, 4 Oct 2026)

| | Backstage | An LLM doing everything |
|---|---|---|
| Per task (same 5 tasks, independent checks) | **$0.0013** | $0.029 (about 20× more) |
| Time per task (same 5 tasks) | 9.3 s | 20.7 s |
| Per decision (408 logged agent tasks) | $0.00008, 0.58 s typical, 1.2 s slowest 5% | $0.0044, 2.2 s |
| Benchmark (10 everyday tasks × 2 runs) | 20 / 20 correct, 0 wrong-but-sure | |
| Six agents at once (Calculator, Weather, Maps, Stocks, Safari, Word) | 6 / 6 in 22.8 s | |

Windows measurements are in [windows/evidence](windows/evidence).

## Repository layout

```
start.sh, start.ps1   launchers (pick the engine for this computer)
mac/                  the macOS engine (TypeScript on Bun + Swift overlay and fast lane)
windows/              the Windows engine (TypeScript on Bun + PowerShell overlay and fast lane, Python speech)
archive/screen-buddy/ an earlier team prototype (a Photopea guide on Vercel), kept for reference
```

## Credits

**Cua Driver** by trycua (MIT), **TypeSafe jev** (`@typesafe-ai/sdk`), **Anthropic Claude**, **ElevenLabs** (text to speech; free plan attribution), **awlevin/typesafe-computer-use** (MIT; the classifier-per-step loop), **faster-whisper** (MIT), **wttr.in**.
