# Test prompts

Last full run (3 Oct 2026, after `prep-tests.sh --minimise-calculator`): **12/12 passed**; 10 of the 12 used no LLM at all.

Run `bash scripts/prep-tests.sh` first, before every test round. It:
* recreates `~/backstage-test/by-type` (10 loose files) and `~/backstage-test/by-name` (7 loose files), so a Finder task always has something to sort;
* opens Calculator, Safari and Finder and **restores any minimised windows** (in the background; the app you're using stays in front).

Add `--minimise-calculator` to also minimise Calculator on purpose: prompt 1 then shows that an agent restores it.

## Showcase: one command, many agents at once

Run `bash scripts/prep-tests.sh` first (S2 sorts the test folder). Measured 3 Oct 2026 with the fast lane on.

| # | Say or type (one command) | Agents | Result |
|---|---|---|---|
| S1 | `I am flying to Tokyo tomorrow. In Maps, how long does it take to drive from the University of Hong Kong to Hong Kong International Airport, in Weather check the weather in Tokyo, in Stocks check Sony stock price, in Safari find how much 10000 Japanese yen is in Hong Kong dollars, in Brave find the flight time from Hong Kong to Tokyo, and make a word doc with a 3 day Tokyo itinerary` | 6: Maps, Weather, Stocks, Safari, Brave, TextEdit→Word | 6/6 in ~22 s: 29 min · 35 km to the airport; Tokyo 17 °C; Sony 23.82; ¥10,000 ≈ HK$497; ~4 h 30 flight; itinerary .docx open in Word. 2 LLM calls (the itinerary, one borderline check) |
| S2 | `My assignment is due tonight. In Finder sort ~/backstage-test/by-name into folders called Lectures, Assignments and Receipts, in Safari look up gradient descent on Wikipedia and tell me who first suggested it, in Maps how long does it take to walk from the University of Hong Kong to Kennedy Town, in Stocks check Nvidia stock price, and make a word doc with a study plan for tonight` | 5: Finder, Safari, Maps, Stocks, TextEdit→Word | 5/5 in 16.6 s: 6 files sorted (one left, with a reason); Cauchy, 1847; 26 min · 1.7 km on foot; Nvidia 233.95; study plan .docx. 1 LLM call |

| S3 | `Friends are visiting tonight. In Maps how long does it take to get from the University of Hong Kong to Tsim Sha Tsui by public transport, in Weather check the weather in Hong Kong, in Safari find what time the Symphony of Lights starts, in Brave find the opening hours of Tim Ho Wan in Sham Shui Po, in Stocks check HSBC stock price, and make a word doc with an evening plan for friends visiting Hong Kong` | 6: Maps (transit), Weather, Safari, Brave, Stocks, TextEdit→Word | 30 min by MTR; Hong Kong 27 °C; Symphony of Lights 8:00 p.m.; Tim Ho Wan 10 am–9:30 pm; HSBC 149.50; evening plan .docx. 1 LLM call. Brave must have a window on the current desktop |

The first sentence ("I am flying to Tokyo tomorrow") asks for nothing, so it is context, not an agent. Maps and Stocks open straight to the answer (`maps://`, `stocks://` links); Maps then waits until the new route is calculated (a background Maps window takes 3–11 s and shows the old route meanwhile).

Type each prompt into the panel (`bun run start`, http://127.0.0.1:3000) or run it with `bun run src/cli.ts "<prompt>"`.

| # | Prompt | What it tests | Expected |
|---|---|---|---|
| 1 | `Clear the calculator and compute 128 times 37` | compiled plan, no LLM; restores a minimised window | 4,736 · ~12 s · no LLM |
| 2 | `In Calculator, what is 15% of 2480?` | percent compiler | 372 · no LLM |
| 3 | `In Calculator add 250 and 175, then subtract 80` | no compiler covers it: jev works alone | 345 · no LLM |
| 4 | `In Safari, look up the University of Hong Kong on Wikipedia and tell me the year it was founded` | search URL compiler + jev picks the answer line | 1911 · ~9 s · no LLM |
| 5 | `In Safari find how tall Lion Rock in Hong Kong is` | Google search + answer extraction | 495 m · ~8 s · no LLM |
| 6 | `open the claude dashboard and typesafe dashboard in a new brave window` | known sites, new window, tabs counted in code | 2 tabs · ~7 s · no LLM |
| 7 | `In TextEdit write 'Demo at 3pm in the Main Building'` | explicit text, scratch document | ~4 s · no LLM |
| 8 | `In TextEdit write a three item packing list for a weekend hike` | creative text: the LLM writes it (1 call) | 3 lines |
| 9 | `In Finder, organise the files in ~/backstage-test/by-type into folders by type` | scripted moves, undo script, file-system check | 10 files into Documents / Images / Text / Spreadsheets |
| 10 | `In Finder, sort ~/backstage-test/by-name into folders called Lectures, Assignments and Receipts` | jev classifies each file; unsure files stay put, with a reason | 6 moved, `team photo.png` left |
| 11 | `Compute 45 times 12 in Calculator, and in TextEdit write 'Results coming soon', and in Safari find the population of Hong Kong` | three agents in parallel (Mint, Red, Blue) | 540 · text · ~7.5 million |
| 12 | `Open YouTube in Safari and play the first video on the home page` | nothing compiles past "open": jev, with the LLM on demand | a video plays · ~23 s · LLM ×4 |
| 13 | `make a seven day japan itinerary from hong kong and make a word doc about it` | creative text (1 LLM call) in a TextEdit scratch document, then saved as a real .docx in code (textutil, read back) and opened in Word | `~/Documents/Backstage/….docx` · ~15 s |

Finder tasks only touch the folder named in the prompt (inside your home folder, never hidden folders or Library). They never delete or overwrite, and each run writes an undo script under `runs/<run>/`.

## What can still make a prompt fail

* **The app is in full screen or on another desktop (Space).** Agents only use windows on the current desktop, and minimised windows are restored. Take the app out of full screen.
* **Cua Driver isn't running, or lost its permissions.** Run `bash scripts/daemon.sh`.
* **You click or type in the same app while an agent is working on it.** Background agents share the screen's input with you.
* **Web answers depend on the live page.** If Google changes its layout, prompt 5 may need one extra step (and the LLM is called once).

## Explain mode (hold or tap Control + Option)

Build once with `bash scripts/build-overlay.sh`, then `bun run start`, which also starts the overlay in the menu bar.

| # | Where | Ask | Expected |
|---|---|---|---|
| E1 | Calculator in front | "How do I work out 15 percent of 80 on this?" | a 5–6 step lesson: each step rings the exact keys; Alice starts ~0.8 s after the drawing; "next" moves on instantly |
| E2 | a Google results page in Safari | "Underline the sentence with the population, and ring the Images tab" | underlines on each line of that sentence, a ring on Images |
| E3 | any app | "What does the button under my mouse do?" | it rings that control and explains it |
| E4 | after E1 | "repeat", "back", "stop" | repeats the step, goes back one, clears everything (no LLM, no new audio) |
| E5 | during E1 | press **Esc** while it talks, then **⌥→**, **⌥→**, **⌥←**, then **Esc**, **Esc** | the voice stops at once (drawings stay); next, next, back; the second Esc clears everything |

## The hotkey starts the agents too (hold or tap Control + Option)

| # | Say or type | Expected |
|---|---|---|
| V1 | "Clear the calculator and compute 128 times 37" | routed to the agents in code; "On it."; a Mint widget bottom right; then "128 times 37 is 4,736." (~14 s) |
| V2 | "Compute 45 times 12 in Calculator, and in TextEdit write 'Results coming soon', and in Safari find the population of Hong Kong" | three widgets (Mint, Red, Blue) with live steps; "In Calculator: 45 times 12 is 540. TextEdit is done. In Safari: …" |
| V3 | "In Safari find how tall Lion Rock in Hong Kong is", then "stop" while it works | "Stopping the agents."; the widget turns red "stopped by the user" within ~1.5 s |
| V4 | "What does the button with the plus and minus do?" (Calculator in front) | routed to explain mode: it rings the ± key and explains it |
