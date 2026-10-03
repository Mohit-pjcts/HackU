// Prices in US dollars per million tokens.
// Read from https://platform.claude.com/docs/en/models/overview on Fri 2 Oct 2026.
// Thinking tokens are billed as output tokens and are included in usage.output_tokens.
// Evidence rule: re-read the page on the day you report numbers and update PRICES_READ_ON.

export const PRICES_READ_ON = "2026-10-02";
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/models/overview";

export const PRICES = Object.freeze({
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
});

/** Cost in USD for one call, or null if the model is not in the table (never guess). */
export function costUsd(model, inputTokens, outputTokens) {
  const p = PRICES[model];
  if (!p) return null;
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
