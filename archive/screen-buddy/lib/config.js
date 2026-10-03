// Server configuration, read from environment variables on every call so tests
// (and a redeploy with new variables) pick up changes. Never log the key.

import { TIERS, tierForModel } from "../src/shared/budget.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function num(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function getConfig() {
  const model = (process.env.MODEL_NAME || "claude-sonnet-5-5").trim();
  const allowed = (process.env.ALLOWED_MODELS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(model)) allowed.unshift(model);

  const effortRaw = (process.env.MODEL_EFFORT ?? "low").trim().toLowerCase();
  const thinkingRaw = (process.env.MODEL_THINKING || "").trim().toLowerCase();
  const tierOverride = (process.env.IMAGE_TIER || "").trim().toLowerCase();

  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model,
    allowedModels: allowed,
    // "low" keeps adaptive thinking short: pointing needs a fast answer, not an essay.
    effort: EFFORTS.has(effortRaw) ? effortRaw : null,
    thinking: thinkingRaw === "adaptive" || thinkingRaw === "disabled" ? thinkingRaw : null,
    mock: process.env.MOCK_MODEL === "1" || process.env.MOCK_MODEL === "true",
    accessCode: process.env.JUDGE_ACCESS_CODE || "",
    maxCallsPerSession: int("MAX_CALLS_PER_SESSION", 80, 1, 10000),
    ratePerMinute: int("RATE_LIMIT_PER_MINUTE", 20, 1, 1000),
    globalPerHour: int("GLOBAL_CALLS_PER_HOUR", 600, 1, 100000),
    timeoutMs: int("MODEL_TIMEOUT_MS", 25000, 2000, 120000),
    maxOutputTokens: int("MODEL_MAX_TOKENS", 2000, 256, 16000),
    // Below this self-reported confidence the buddy says "I can't tell" instead of pointing.
    confidenceFloor: num("CONFIDENCE_FLOOR", 0.5, 0, 1),
    tierFor(modelId) {
      if (tierOverride === "high") return TIERS.high;
      if (tierOverride === "standard") return TIERS.standard;
      return tierForModel(modelId);
    },
  };
}
