// Image size budget for Claude vision, shared by the browser and the server.
//
// Source: Anthropic vision-coordinates docs, read Fri 2 Oct 2026.
// - Images are cut into 28 x 28 px patches; visual tokens = ceil(w/28) * ceil(h/28).
// - High-resolution tier: long edge <= 2576 px and <= 4784 visual tokens.
// - Standard tier: long edge <= 1568 px and <= 1568 visual tokens.
// - Anything bigger is silently downsized, which shifts every coordinate the model
//   returns. We pre-resize to fit, and the server also sets
//   transformations.oversized_image = "error" so a mistake fails loudly.

export const PATCH = 28;

export const TIERS = Object.freeze({
  high: Object.freeze({ name: "high", maxEdge: 2576, maxTokens: 4784 }),
  standard: Object.freeze({ name: "standard", maxEdge: 1568, maxTokens: 1568 }),
});

export function visualTokens(width, height) {
  return Math.ceil(width / PATCH) * Math.ceil(height / PATCH);
}

export function fitsBudget(width, height, tier) {
  return Math.max(width, height) <= tier.maxEdge && visualTokens(width, height) <= tier.maxTokens;
}

/**
 * Largest size with the same aspect ratio that fits the tier. Never upscales.
 * Returns integer pixel sizes plus the scale actually applied.
 */
export function fitSize(width, height, tier) {
  if (!(width > 0 && height > 0)) throw new Error("fitSize: width and height must be positive");
  if (fitsBudget(width, height, tier)) return { width, height, scale: 1 };
  let scale = Math.min(1, tier.maxEdge / Math.max(width, height));
  // Token limit: (w*s/28) * (h*s/28) <= maxTokens  =>  s <= sqrt(maxTokens * 784 / (w*h))
  scale = Math.min(scale, Math.sqrt((tier.maxTokens * PATCH * PATCH) / (width * height)));
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  // ceil() rounding can still push us one patch over; shrink until it fits.
  while (!fitsBudget(w, h, tier)) {
    scale *= 0.99;
    w = Math.max(1, Math.floor(width * scale));
    h = Math.max(1, Math.floor(height * scale));
  }
  return { width: w, height: h, scale: w / width };
}

/**
 * Which vision tier a model ID uses. Unknown models get the standard (smaller)
 * tier: a too-small image only costs accuracy, a too-large one gets rejected.
 * Override with the IMAGE_TIER env var on the server if a new model appears.
 */
export function tierForModel(model = "") {
  const m = String(model).toLowerCase();
  if (/claude-(opus|sonnet|fable)-5/.test(m)) return TIERS.high;
  if (/claude-(opus|sonnet)-4-[7-9]/.test(m)) return TIERS.high;
  return TIERS.standard;
}
