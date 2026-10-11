// Fails if any agent or meta-harness module can reach the independent validator (and its hidden tests).
//   npm run verify:isolation
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps/worker/src/agents", "apps/worker/src/rsi"];
const FORBIDDEN = [/@mongomation\/checks/, /checks\/src/, /hidden\/regression/];

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const offenders = ROOTS.flatMap(files).flatMap((f) => {
  const src = readFileSync(f, "utf8");
  return FORBIDDEN.filter((re) => re.test(src)).map((re) => `${f}: matches ${re}`);
});
if (offenders.length) {
  console.error(`isolation violated:\n${offenders.join("\n")}`);
  process.exit(1);
}
console.log(`isolation ok: ${ROOTS.flatMap(files).length} agent/meta files never import the validator`);
