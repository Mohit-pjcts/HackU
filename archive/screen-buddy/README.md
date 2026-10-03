# Screen Buddy — HacKU 2026, Deep Tech 2

A voice-driven pointer for someone using a Photoshop-style image editor for the first time. It sees the shared browser tab, shows them the next click with a ring, says it out loud, and checks whether the step really worked. It never clicks for them.

- **Capability:** an expert at your elbow who can see your screen (a vision-language model grounded on a live screen, plus checks on the document state).
- **Setting:** a first-time user of one image editor, alone, with no one to ask.
- **Barrier:** expertise.
- **Editor:** [Photopea](https://www.photopea.com), a free web editor that looks like Photoshop, embedded in our page. It is not Photoshop and Adobe is not involved.

> Status: the brain (server function, three pointing modes, step checks, limits, evaluation tools) is in. The page with the embedded editor, capture, overlay and voice is being built. Evidence numbers will be added here only once measured.

## Try the brain locally

```bash
npm install
npm run dev:mock            # no API key needed: fake answers
# open http://localhost:3000/tools/brain-lab.html and load the files in tools/fixtures/
npm test
```

With a key: copy `.env.example` to `.env`, fill in `ANTHROPIC_API_KEY`, run `npm run dev`. Details, the API contract and the evaluation workflow: [docs/brain.md](docs/brain.md).

## Layout

```
api/            serverless functions: step (where to click), verify (is the step done), health
lib/            server code: validation, prompt, model call, answer checks, limits, pricing
src/modes.js    browser: resize, grid, zoomed refine pass, coordinate mapping, upload log
src/checks.js   browser: step checks through Photopea scripts and exported pixels
src/shared/     pure maths shared by browser and server (image budget, grid, crops)
tools/          Brain Lab test page, fixtures, autolabel/probe/eval scripts (evaluation only)
test/           node:test suite
vendor/         photopea.js wrapper (MIT)
```

## What leaves the device

Only when the user asks for help: a JPEG of the shared browser tab (or a zoomed crop of it) and the words they said or typed. They go to our server function and on to Anthropic's API. The server stores neither; it logs sizes, token counts, cost and timing. The page lists every upload.

## Credits

- [Clicky](https://github.com/farzaa/clicky) by Farza (MIT) — the idea of a voice buddy that points at your screen. No code was copied.
- [Photopea](https://www.photopea.com) — the embedded editor, used through its public API. Free to embed; its own ads appear in the embed.
- [photopea.js](https://github.com/yikuansun/PhotopeaAPI) v1.1.2 by Yikuan Sun (MIT) — in `vendor/photopea/` with its licence.
- [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) (MIT), [zod](https://zod.dev) (MIT), [Playwright](https://playwright.dev) (Apache-2.0, evaluation tools only).
- Sample photo in `tools/fixtures/`: NASA image S90-38573.

All code in this repository was written during HacKU 2026 (2–4 Oct). AI coding assistants were used, as the rules allow.
