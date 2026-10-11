// RSI seed / restore (append-only; see apps/worker/src/harness/seed.ts).
//   npm run harness:seed             new version = bare one-shot (no rules) + repair budget 1, made current
//   npm run harness:restore -- v0    new version = copy of v0, made current again
// Restart the worker afterwards so it picks up the new current harness.
import { client, connect } from "../apps/worker/src/db/index.ts";
import { makeSeedCurrent, restoreVersion } from "../apps/worker/src/harness/seed.ts";

await connect();
try {
  if (process.argv.includes("--restore")) {
    const raw = process.argv[process.argv.indexOf("--restore") + 1] ?? "";
    const from = Number(raw.replace(/^v/, ""));
    if (raw === "" || !Number.isInteger(from) || from < 0) throw new Error(`usage: npm run harness:restore -- v0 (got "${raw}")`);
    const { config, previous } = await restoreVersion(from);
    console.log(`restored: v${config.version} (${config.label}) is now current; was v${previous.version}${previous.label ? ` (${previous.label})` : ""}`);
  } else {
    const { created, config, previous } = await makeSeedCurrent();
    console.log(
      created
        ? `seed: v${config.version} (label seed, derived from v${config.parent}) is now current; was v${previous.version}. rules=${config.rules.length}, lessons_k=${config.context.lessons_k}, repair_budget=${config.workflow.repair_budget}, preflight=${config.workflow.preflight_compile}`
        : `seed: current harness v${config.version} already is the seed; nothing changed`,
    );
  }
} finally {
  await client.close();
}
