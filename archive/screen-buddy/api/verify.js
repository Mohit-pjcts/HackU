// POST /api/verify — "is this step finished?" from a fresh screenshot.
// Used only for steps that no script or pixel check can confirm ("model-checked" in the evidence).
import { createHandler } from "../lib/pipeline.js";

export default createHandler("verify");
