// Raindrop Evals suite for the ablation table. Rows are the frozen HELD-OUT benchmark cases (specs/benchmark.json);
// the "agent" for each row is the measured result of one ablation condition (bare / v0 / vN) that runAblationJob
// stored in Atlas `benchmark_runs` — nothing is re-generated or re-simulated here, so the eval reports exactly
// what the rig measured. Each row is also emitted as a Raindrop interaction (event "ablation_case") so the eval
// has a trace to attach verdicts to. Compare two conditions with `raindrop-evals compare <runA> <runB>`.
//   ABLATION_CONDITION=v0   npm run raindrop:eval     (default v0; also "bare", "v1", ...)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineDataset, defineEvalSuite, defineLocalEvaluator, Raindrop } from "raindrop-ai";
import { col, connect } from "../apps/worker/src/db/index.ts";

interface Metrics {
  satisfaction: number;
  safety: [number, number];
  tests: [number, number];
  attempts: number;
  costUsd: number;
  status: string;
}
interface CaseResult {
  caseId: string;
  condition: string;
  found: boolean;
  benchmarkId?: string;
  metrics?: Metrics;
}

const condition = process.env.ABLATION_CONDITION || "v0";
const cases = (JSON.parse(readFileSync(new URL("../specs/benchmark.json", import.meta.url), "utf8")).cases as { id: string; split: string; sceneId: string; specText: string }[]).filter((c) => c.split === "heldout");
const rd = new Raindrop({ writeKey: process.env.RAINDROP_WRITE_KEY ?? "", projectId: process.env.RAINDROP_PROJECT_ID || undefined });
let connected: Promise<unknown> | null = null;

async function measured(caseId: string): Promise<CaseResult> {
  connected ??= connect();
  await connected;
  const row = await col.benchmarks().findOne({ condition: `ablation:${condition}`, caseId }, { sort: { createdAt: -1 } });
  return row ? { caseId, condition, found: true, benchmarkId: String(row.benchmarkId), metrics: row.metrics as Metrics } : { caseId, condition, found: false };
}

export default defineEvalSuite<CaseResult>({
  name: "mongomation-ablation-heldout",
  dataset: defineDataset({
    id: "mongomation-heldout",
    name: "MongoMation held-out benchmark cases",
    rows: cases.map((c) => ({ id: c.id, name: c.id, input: c.specText, properties: { sceneId: c.sceneId, split: c.split } })),
  }),
  concurrency: 1,
  run: async (row) => {
    const result = await measured(row.id);
    const m = result.metrics;
    const interaction = rd.begin({ eventId: randomUUID(), event: "ablation_case", userId: "mongomation-evals", convoId: `ablation-${condition}`, input: row.input ?? row.id, properties: { case_id: row.id, condition } });
    interaction.setFeatureFlags({ harness_version: condition });
    await interaction.finish({ output: m ? `${m.status}: satisfaction ${(m.satisfaction * 100).toFixed(0)}%, tests ${m.tests[0]}/${m.tests[1]}, safety ${m.safety[0]}/${m.safety[1]}, attempts ${m.attempts}, $${m.costUsd.toFixed(3)}` : `no stored ablation result for ${condition}` });
    return result;
  },
  evaluators: [
    {
      evaluator: defineLocalEvaluator<CaseResult>({
        slug: "requirement-satisfaction",
        name: "Requirement satisfaction (measured on the rig)",
        output: "number",
        judge: ({ result }) => ({ value: result.metrics?.satisfaction ?? 0, note: result.found ? `benchmark ${result.benchmarkId}` : "no stored result" }),
      }),
    },
    {
      evaluator: defineLocalEvaluator<CaseResult>({
        slug: "safety-tests-pass",
        name: "All safety tests passed",
        output: "boolean",
        judge: ({ result }) => ({ pass: !!result.metrics && result.metrics.safety[0] === result.metrics.safety[1] }),
      }),
    },
  ],
});
