// Thin Claude wrapper: one forced tool call per request, so the reply is always structured JSON, plus cost accounting.
import Anthropic from "@anthropic-ai/sdk";

/** USD per 1M tokens [input, output], as listed on Anthropic's models page (read 2 Oct 2026) */
export const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};
export const HELPER_MODEL = "claude-haiku-4-5-20251001";
export const LLM_BRAIN_MODEL = process.env.LLM_BRAIN_MODEL ?? "claude-sonnet-5-5";

let client: Anthropic | null = null;
const noForcedTool = new Set<string>();
export const hasClaude = () => !!process.env.ANTHROPIC_API_KEY;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 1, timeout: 30000 });
  return client;
}

export interface ToolCallResult<T> { input: T; inputTokens: number; outputTokens: number; costUsd: number; ms: number }

export async function callTool<T>(opts: {
  model: string;
  system: string;
  /** plain text, or content blocks (e.g. an image followed by text) */
  user: string | Anthropic.ContentBlockParam[];
  tool: { name: string; description: string; input_schema: Record<string, unknown> };
  maxTokens?: number;
}): Promise<ToolCallResult<T>> {
  const t0 = performance.now();
  const create = (forced: boolean) =>
    getClient().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 400,
      system: forced ? opts.system : `${opts.system}\nAlways answer by calling the ${opts.tool.name} tool exactly once.`,
      tools: [opts.tool as any],
      tool_choice: forced ? { type: "tool", name: opts.tool.name } : { type: "auto" },
      messages: [{ role: "user", content: opts.user }],
    });
  let msg;
  if (noForcedTool.has(opts.model)) msg = await create(false);
  else {
    try {
      msg = await create(true);
    } catch (e: any) {
      // some models (e.g. Sonnet 5.5) reject a forced tool_choice: remember and use "auto" + an instruction
      if (!/tool_choice/.test(String(e?.message ?? e))) throw e;
      noForcedTool.add(opts.model);
      msg = await create(false);
    }
  }
  let block = msg.content.find((b: any) => b.type === "tool_use") as any;
  if (!block && noForcedTool.has(opts.model)) {
    // without a forced tool choice the model sometimes answers in plain text: ask once more
    msg = await create(false);
    block = msg.content.find((b: any) => b.type === "tool_use") as any;
  }
  if (!block) {
    const said = msg.content.map((b: any) => b.text ?? b.type).join(" ").slice(0, 200);
    throw new Error(`${opts.model} returned no tool call (stop: ${msg.stop_reason}; said: ${said})`);
  }
  const [pin, pout] = PRICES[opts.model] ?? [0, 0];
  const inputTokens = msg.usage?.input_tokens ?? 0;
  const outputTokens = msg.usage?.output_tokens ?? 0;
  return {
    input: block.input as T,
    inputTokens,
    outputTokens,
    costUsd: (inputTokens * pin + outputTokens * pout) / 1e6,
    ms: Math.round(performance.now() - t0),
  };
}
