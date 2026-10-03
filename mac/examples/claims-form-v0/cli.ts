// Headless run: `bun run src/cli.ts [--stop-after N]` runs the demo batch against the real Safari window and prints the report.
// Useful for testing and as a fallback if the panel misbehaves at the booth.
import { startReplica } from "../replica/server.ts";
import { Oracle } from "./adapters/claims-form.ts";
import { SEED_CLAIMS, newItem, runBatch } from "./batch.ts";
import { AGENT } from "./contracts.ts";
import { FallbackClassifier, JevClassifier, PolicyClassifier } from "./decide.ts";
import { CliDriver } from "./driver.ts";
import { RunLogger } from "./logger.ts";
import { runPreflight } from "./preflight.ts";

const useJev = !!process.env.TYPESAFE_API_KEY && !process.argv.includes("--policy");
const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : undefined;

try {
  startReplica(8765);
} catch {
  /* already running in another process */
}
const driver = new CliDriver();
const oracle = new Oracle();
await oracle.reset();

const checks = await runPreflight(driver, AGENT, { openForm: true });
for (const c of checks) console.log(`${c.ok ? "OK  " : c.fatal ? "FAIL" : "warn"} ${c.name}: ${c.detail}`);
if (checks.some((c) => c.fatal && !c.ok)) process.exit(1);

const claims = only ? SEED_CLAIMS.slice(0, only) : SEED_CLAIMS;
const items = claims.map((t, i) => newItem(`c${i + 1}`, t, "seed"));
const runId = `cli-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const log = new RunLogger(runId);
log.subscribe((l) => {
  if (l.type === "step") console.log(`  [${l.itemId} s${l.step}] ${l.decision.backend} ${l.decision.kind}${l.decision.field ? "(" + l.decision.field + ")" : ""} gate=${l.decision.gate.toFixed(2)}  ${l.acted}  (obs ${l.ms.observe} dec ${l.ms.decide} act ${l.ms.act} ms)`);
  if (l.type === "oracle") console.log(`  [${l.itemId}] oracle ${l.result.ok ? "OK" : "MISMATCH " + l.result.diff.join("; ")}`);
  if (l.type === "guard") console.log(`  [${l.itemId}] guard ${l.rule}: ${l.detail}`);
  if (l.type === "item_end") console.log(`${l.item.status === "verified" ? "VERIFIED " : "EXCEPTION"} ${l.item.id} ${l.item.claim?.payee ?? l.item.raw} ${l.item.exception ? `[${l.item.exception.code}] ${l.item.exception.reason}` : ""}  (${l.item.seconds.toFixed(1)} s)`);
});
const classifier = useJev ? new FallbackClassifier(new JevClassifier()) : new PolicyClassifier();
console.log(`classifier: ${useJev ? "TypeSafe jev" : "OFFLINE POLICY (not jev)"}   run: ${runId}`);
const report = await runBatch({ runId, driver, agent: AGENT, classifier, oracle, log, signal: new AbortController().signal }, items);
console.log(`\n${report.verified.length} verified, ${report.exceptions.length} exceptions, ${report.seconds.toFixed(0)} s, $${report.costUsd.toFixed(5)}, decisions ${report.counts.decisions}, gui ${report.counts.gui}, scripted ${report.counts.script}, foreground ${report.counts.foreground}`);
console.log(`log: ${log.file}`);
await driver.endAll();
process.exit(0);
