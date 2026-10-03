// Test helpers: tiny valid image headers and fake Vercel-style req/res objects.

/** A PNG whose header says width x height (pixel data is never decoded by the server). */
export function pngBase64(width, height) {
  const buf = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString("base64");
}

/** A JPEG with an APP0 segment then a baseline SOF0 frame header. */
export function jpegBuffer(width, height, sof = 0xc0) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sofSeg = Buffer.alloc(19);
  sofSeg[0] = 0xff; sofSeg[1] = sof;
  sofSeg.writeUInt16BE(17, 2);
  sofSeg[4] = 8;
  sofSeg.writeUInt16BE(height, 5);
  sofSeg.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, Buffer.alloc(80)]);
}

export function fakeReq({ method = "POST", body, headers = {} } = {}) {
  return { method, body, headers: { "x-forwarded-for": "203.0.113.7", ...headers }, socket: { remoteAddress: "127.0.0.1" } };
}

export function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this.body = s ? JSON.parse(s) : null; this.headersSent = true; },
  };
  return res;
}

export function stepBody(over = {}) {
  return {
    sessionId: "test-session-0001",
    stepId: "pick-magic-wand",
    stepGoal: "Choose the Magic Wand tool",
    targetHint: "left toolbar",
    transcript: "where do I click?",
    imageBase64: pngBase64(1920, 1080),
    imageWidth: 1920,
    imageHeight: 1080,
    mode: "direct",
    ...over,
  };
}

/** Run with a clean set of env vars, restoring afterwards. */
export async function withEnv(vars, fn) {
  const keys = ["ANTHROPIC_API_KEY", "MODEL_NAME", "ALLOWED_MODELS", "MODEL_EFFORT", "MODEL_THINKING", "MOCK_MODEL", "JUDGE_ACCESS_CODE",
    "MAX_CALLS_PER_SESSION", "RATE_LIMIT_PER_MINUTE", "GLOBAL_CALLS_PER_HOUR", "CONFIDENCE_FLOOR", "IMAGE_TIER"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
