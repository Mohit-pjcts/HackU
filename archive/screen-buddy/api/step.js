// POST /api/step — "where should the user click next?"
// Contract: see docs/brain.md (request/response fields, modes, errors).
import { createHandler } from "../lib/pipeline.js";

export default createHandler("step");
