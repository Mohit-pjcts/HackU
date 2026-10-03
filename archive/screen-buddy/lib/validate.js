// Request validation for /api/step and /api/verify. Everything from the browser is
// untrusted: bound every string, every number and every array.

import { z } from "zod";
import { GRID_LIMITS } from "../src/shared/geometry.js";

// About 4.4 MB of base64. Vercel rejects request bodies over 4.5 MB with a 413.
export const MAX_BASE64_CHARS = 4_400_000;

const sessionId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ and - only");
const shortText = (max) => z.string().max(max);
const dim = z.number().int().min(16).max(8000);
const imageBase64 = z.string().min(100).max(MAX_BASE64_CHARS);

const historyItem = z.object({
  stepId: z.string().max(80),
  status: z.string().max(20),
});

export const stepRequestSchema = z
  .object({
    sessionId,
    stepId: z.string().min(1).max(80),
    stepGoal: z.string().min(1).max(400),
    targetHint: shortText(400).default(""),
    transcript: shortText(600).default(""),
    commonMistakes: z.array(shortText(200)).max(6).default([]),
    imageBase64,
    imageWidth: dim,
    imageHeight: dim,
    mode: z.enum(["direct", "grid", "refine"]).default("direct"),
    history: z.array(historyItem).max(40).default([]),
    gridCols: z.number().int().min(GRID_LIMITS.minCols).max(GRID_LIMITS.maxCols).optional(),
    gridRows: z.number().int().min(GRID_LIMITS.minRows).max(GRID_LIMITS.maxRows).optional(),
    cropOffsetX: z.number().min(0).max(20000).optional(),
    cropOffsetY: z.number().min(0).max(20000).optional(),
    cropScale: z.number().min(0.1).max(8).optional(),
    model: z.string().max(80).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "refine") {
      for (const k of ["cropOffsetX", "cropOffsetY", "cropScale"]) {
        if (v[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: `${k} is required in refine mode` });
      }
    }
  });

export const verifyRequestSchema = z.object({
  sessionId,
  stepId: z.string().min(1).max(80),
  stepGoal: z.string().min(1).max(400),
  doneWhen: z.string().min(1).max(400),
  imageBase64,
  imageWidth: dim,
  imageHeight: dim,
  model: z.string().max(80).optional(),
});

/** Returns { ok: true, data } or { ok: false, issues: [{ path, message }] } with at most 8 issues. */
export function validate(schema, body) {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, data: r.data };
  return {
    ok: false,
    issues: r.error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
