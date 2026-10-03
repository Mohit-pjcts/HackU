// Starts the live panel on PORT (default 3000), or the next free port if that one is taken.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startPanel } from "./server.ts";

const first = Number(process.env.PORT ?? 3000);
let server: ReturnType<typeof startPanel> | undefined;
for (let port = first; port < first + 10 && !server; port++) {
  try {
    server = startPanel(port);
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE") throw e;
    console.log(`port ${port} is in use, trying ${port + 1}…`);
  }
}
if (!server) {
  console.error(`no free port between ${first} and ${first + 9}: stop the other panel (pkill -f src/main.ts) or set PORT`);
  process.exit(1);
}
console.log(`Backstage panel  http://127.0.0.1:${server.port}/`);
// explain mode: start the on-screen overlay (build it once with: bash scripts/build-overlay.sh)
const overlay = join(import.meta.dir, "..", "overlay", "build", "Backstage Overlay.app");
if (process.env.OVERLAY !== "off" && existsSync(overlay)) {
  Bun.spawn(["open", "-g", overlay, "--args", "--port", String(server.port)]);
  console.log("explain mode: hold Control + Option to talk, tap it to type (overlay in the menu bar)");
} else if (!existsSync(overlay)) console.log("explain mode: build the overlay first with  bash scripts/build-overlay.sh");
console.log(`TypeSafe key ${process.env.TYPESAFE_API_KEY ? "set" : "MISSING"} · Anthropic key ${process.env.ANTHROPIC_API_KEY ? "set" : "MISSING"}`);
