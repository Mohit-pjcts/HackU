// GET /api/health — what the server is configured to do. No secrets.
// The page reads imageBudget from here so it resizes frames for the model actually in use.
import { getConfig } from "../lib/config.js";
import { sendJson } from "../lib/http.js";
import { PRICES, PRICES_READ_ON, PRICES_SOURCE } from "../lib/pricing.js";

export default function handler(req, res) {
  const cfg = getConfig();
  const budgets = Object.fromEntries(cfg.allowedModels.map((m) => [m, cfg.tierFor(m)]));
  sendJson(res, 200, {
    ok: true,
    model: cfg.mock ? "mock" : cfg.model,
    mock: cfg.mock,
    keyConfigured: Boolean(cfg.apiKey),
    allowedModels: cfg.allowedModels,
    imageBudget: cfg.tierFor(cfg.model),
    imageBudgets: budgets,
    effort: cfg.effort,
    accessCodeRequired: Boolean(cfg.accessCode),
    limits: {
      perVisitorPerMinute: cfg.ratePerMinute,
      perSession: cfg.maxCallsPerSession,
      globalPerHourPerInstance: cfg.globalPerHour,
    },
    confidenceFloor: cfg.confidenceFloor,
    prices: Object.fromEntries(cfg.allowedModels.filter((m) => PRICES[m]).map((m) => [m, PRICES[m]])),
    pricesReadOn: PRICES_READ_ON,
    pricesSource: PRICES_SOURCE,
  });
}
