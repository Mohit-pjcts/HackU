// A batch: rules in code first (cheap, instant, no GUI), then the agent does the claims that remain.
// Every item ends exactly one way: verified with proof, or an exception with a reason. Nothing is silent.
import type { BatchItem, Claim, Report } from "./contracts.ts";
import { emptyCounts } from "./contracts.ts";
import { nowIso } from "./logger.ts";
import { runItem, type RunCtx } from "./loop.ts";
import { parseClaim } from "./parse.ts";

export const MANDATE_HKD = 500; // claims above this are held for a committee member

export function newItem(id: string, raw: string, source: BatchItem["source"] = "typed", today = new Date()): BatchItem {
  const p = parseClaim(raw, today);
  const item: BatchItem = {
    id,
    source,
    raw,
    claim: p.claim,
    status: "pending",
    steps: 0,
    costUsd: 0,
    seconds: 0,
    counts: emptyCounts(),
  };
  if (!p.claim && p.problem) {
    item.status = "exception";
    item.exception = { code: p.problem.code, reason: p.problem.reason };
  }
  return item;
}

export const SEED_CLAIMS: string[] = [
  "Chan Tai Man, food, 128.50, 30/09/2026, FPS",
  "Lee Siu Ming, transport, 42, 01/10/2026, Cash",
  "Wong Ka Yan, venue, 1200, 02/10/2026, FPS", // over the mandate: held
  "Ng Wai Kit, printing, 85.00, 29/09/2026, Cash",
  "Ho Mei, food, 66.80, last Fri, FPS", // ambiguous date: asked, not guessed
  "Cheung Lok Yi, food, 54.00, 02/10/2026, FPS",
];

export function preCheck(claim: Claim, existing: { payee: string; amount: string; date: string }[]): { code: "over_mandate" | "duplicate"; reason: string } | null {
  if (Number(claim.amount) > MANDATE_HKD) {
    return { code: "over_mandate", reason: `HK$${claim.amount} is above the HK$${MANDATE_HKD} mandate: needs a committee member` };
  }
  if (existing.some((r) => r.payee === claim.payee && r.amount === claim.amount && r.date === claim.date)) {
    return { code: "duplicate", reason: `a claim for ${claim.payee}, HK$${claim.amount} on ${claim.date} already exists` };
  }
  return null;
}

export async function runBatch(ctx: RunCtx, items: BatchItem[]): Promise<Report> {
  const t0 = performance.now();
  ctx.log.write({ type: "run_start", runId: ctx.runId, t: nowIso(), classifier: ctx.classifier.backend, model: ctx.classifier.backend === "jev" ? "jev-1.13.0" : "rules-v1", items });

  for (const item of items) {
    if (ctx.signal.aborted) break;
    if (item.status === "exception") {
      // already refused when it was parsed (for example an ambiguous date)
      ctx.log.write({ type: "item_end", runId: ctx.runId, t: nowIso(), item });
      continue;
    }
    if (item.status !== "pending" || !item.claim) continue;

    const db = await ctx.oracle.all();
    const earlier = items.filter((o) => o.status === "verified" && o.claim).map((o) => o.claim!);
    const refuse = preCheck(item.claim, [...db, ...earlier]);
    if (refuse) {
      item.status = "exception";
      item.exception = refuse;
      ctx.log.write({ type: "guard", runId: ctx.runId, t: nowIso(), itemId: item.id, rule: refuse.code, detail: refuse.reason });
      ctx.log.write({ type: "item_end", runId: ctx.runId, t: nowIso(), item });
      continue;
    }
    await runItem(ctx, item);
  }

  // anything not reached because the run was stopped is reported, not dropped
  for (const item of items) {
    if (item.status === "pending") {
      item.status = "exception";
      item.exception = { code: "stopped", reason: "the run was stopped before this claim" };
      ctx.log.write({ type: "item_end", runId: ctx.runId, t: nowIso(), item });
    }
  }

  const report = buildReport(ctx.runId, items, ctx.classifier.backend, (performance.now() - t0) / 1000);
  ctx.log.write({ type: "run_end", runId: ctx.runId, t: nowIso(), report });
  return report;
}

export function buildReport(runId: string, items: BatchItem[], classifier: Report["classifier"], seconds: number): Report {
  const counts = emptyCounts();
  let costUsd = 0;
  for (const it of items) {
    costUsd += it.costUsd;
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += it.counts[k];
  }
  return {
    runId,
    verified: items.filter((i) => i.status === "verified"),
    exceptions: items.filter((i) => i.status === "exception"),
    costUsd,
    seconds,
    counts,
    classifier,
  };
}
