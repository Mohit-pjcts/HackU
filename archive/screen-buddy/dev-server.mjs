// Local development server: serves the static site and runs /api/* the way Vercel does.
//   npm run dev        -> real model (needs ANTHROPIC_API_KEY in .env)
//   npm run dev:mock   -> fake model, no key, no cost
// Open http://localhost:3000 (localhost counts as a secure origin, so mic and tab capture work).

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 3000);

// Minimal .env loader (no dependency). Existing environment variables win.
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined && value !== "") process.env[m[1]] = value;
  }
}
if (process.argv.includes("--mock")) process.env.MOCK_MODEL = "1";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
  ".ico": "image/x-icon", ".webp": "image/webp",
};

const apiCache = new Map();
async function apiHandler(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = join(ROOT, "api", `${name}.js`);
  if (!existsSync(file)) return null;
  if (!apiCache.has(name)) apiCache.set(name, (await import(new URL(`./api/${name}.js`, import.meta.url))).default);
  return apiCache.get(name);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handler = await apiHandler(url.pathname.slice(5).replace(/\/$/, ""));
      if (!handler) {
        res.statusCode = 404;
        return res.end("Not found");
      }
      return await handler(req, res);
    }

    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT + sep) || /[\\/](\.env|\.git|node_modules)([\\/]|$)/.test(file)) {
      res.statusCode = 403;
      return res.end("Forbidden");
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    // Same as vercel.json: Photopea (another origin) must be able to fetch our sample images.
    if (path.startsWith("/samples/")) res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Server error");
    }
  }
});

server.listen(PORT, () => {
  const mode = process.env.MOCK_MODEL === "1" ? "MOCK model (no API calls)" : `model ${process.env.MODEL_NAME || "claude-sonnet-5-5"}`;
  console.log(`Screen buddy dev server on http://localhost:${PORT}  [${mode}]`);
  console.log(`Brain test page: http://localhost:${PORT}/tools/brain-lab.html`);
});
