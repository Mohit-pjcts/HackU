// Turn the model's JSON into the response the page uses. Nothing the model says is
// trusted until it passes these checks; anything odd becomes "I can't tell".

import { z } from "zod";
import { boxCenter, cellToPoint, CELL_POSITIONS, sanitizeBox } from "../src/shared/geometry.js";

const CANNOT_TELL_SAY = "I can't tell where to click from this screen. Can you tell me what you see?";

const pointingSchema = z.object({
  observation: z.string().max(2000),
  targetVisible: z.boolean(),
  box: z.array(z.number()).nullable().optional(),
  cell: z.string().max(10).nullable().optional(),
  position: z.enum(CELL_POSITIONS).nullable().optional(),
  offTrack: z.boolean(),
  say: z.string().max(2000),
  confidence: z.number(),
});

const verifyOutSchema = z.object({
  observation: z.string().max(2000),
  done: z.enum(["yes", "no", "cannot_tell"]),
  say: z.string().max(2000),
  confidence: z.number(),
});

function tidySay(s, fallback) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return fallback;
  return t.length > 300 ? `${t.slice(0, 297)}...` : t;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * @param data   parsed model JSON (or null)
 * @param req    validated request
 * @param size   { width, height } of the image the model saw
 * @param floor  confidence below which we refuse to point
 * @returns {{ say, target, targetBox, modelTarget, modelBox, confidence, cannotTell, offTrack, observation, reason }}
 */
export function interpretPointing(data, req, size, floor) {
  const parsed = pointingSchema.safeParse(data);
  if (!parsed.success) {
    return {
      say: CANNOT_TELL_SAY, target: null, targetBox: null, modelTarget: null, modelBox: null,
      confidence: 0, cannotTell: true, offTrack: false, observation: "", reason: "unparseable_model_output",
    };
  }
  const d = parsed.data;
  const confidence = clamp01(d.confidence);
  const say = tidySay(d.say, CANNOT_TELL_SAY);

  let modelBox = null;
  let modelTarget = null;
  if (req.mode === "grid") {
    if (d.cell) {
      const hit = cellToPoint(d.cell, d.position || "center", req.gridCols, req.gridRows, size.width, size.height);
      if (hit) {
        modelTarget = hit.point;
        modelBox = hit.box;
      }
    }
  } else if (d.box) {
    modelBox = sanitizeBox(d.box, size.width, size.height);
    if (modelBox) modelTarget = boxCenter(modelBox);
  }

  let reason = null;
  if (!d.targetVisible) reason = "model_says_not_visible";
  else if (!modelTarget) reason = req.mode === "grid" ? "invalid_cell" : "invalid_box";
  else if (confidence < floor) reason = "below_confidence_floor";

  const cannotTell = reason !== null;
  // When we refuse to point, the model's words may still sound sure ("Click the wand"),
  // which would contradict the missing ring. Say plainly that it is a guess.
  let finalSay = say;
  if (reason === "below_confidence_floor") finalSay = tidySay(`I'm not sure about this one, so no pointer. My best guess: ${say}`, CANNOT_TELL_SAY);
  else if (reason === "invalid_box" || reason === "invalid_cell") finalSay = CANNOT_TELL_SAY;
  return {
    say: finalSay,
    target: cannotTell ? null : modelTarget,
    targetBox: cannotTell ? null : modelBox,
    // Always returned for evaluation: lets the scorer sweep the confidence threshold offline.
    modelTarget,
    modelBox,
    confidence,
    cannotTell,
    offTrack: d.offTrack,
    observation: tidySay(d.observation, ""),
    reason,
  };
}

export function interpretVerify(data) {
  const parsed = verifyOutSchema.safeParse(data);
  if (!parsed.success) {
    return { done: null, say: "I couldn't check that step. Tell me when you think it's done.", confidence: 0, observation: "", reason: "unparseable_model_output" };
  }
  const d = parsed.data;
  return {
    done: d.done === "yes" ? true : d.done === "no" ? false : null,
    say: tidySay(d.say, d.done === "yes" ? "That step looks done." : "That step doesn't look done yet."),
    confidence: clamp01(d.confidence),
    observation: tidySay(d.observation, ""),
    reason: d.done === "cannot_tell" ? "model_cannot_tell" : null,
  };
}
