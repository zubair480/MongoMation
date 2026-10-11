// READ-ONLY live rig smoke test: OpenPLC login/ping/status + Factory I/O tags/values vs the scene file.
// No uploads, no start/stop, no tag writes, no forces.
//   npx tsx --env-file-if-exists=.env scripts/rig-smoke.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "undici";

const TIMEOUT_MS = 20_000; // the rig API is slow (~0.3-1 s per call, more under load)
const SCENE_FILE = join(process.cwd(), "scenes", "sorting-by-height-basic.json");

let failed = false;
const row = (ok: boolean | null, name: string, detail: string) => {
  if (ok === false) failed = true;
  console.log(`${ok === null ? "–" : ok ? "✓" : "✗"} ${name.padEnd(16)} ${detail}`);
};
const info = (line: string) => console.log(`  ${line}`);

/** Error message incl. the low-level cause (fetch wraps ECONNREFUSED etc. in `cause`). Never contains secrets. */
function why(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError") return `timed out after ${TIMEOUT_MS / 1000}s`;
  const cause = e?.cause ? ` (${e.cause.code ?? ""}${e.cause.code && e.cause.message ? ": " : ""}${e.cause.message ?? ""})` : "";
  return `${e?.message ?? String(err)}${cause}`;
}

async function getText(url: string, init: RequestInit & { dispatcher?: Agent } = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) } as RequestInit);
  return { status: res.status, ok: res.ok, text: await res.text() };
}

// ------------------------------------------------------------------------------------------------
// 1. OpenPLC
// ------------------------------------------------------------------------------------------------
const plcUrl = (process.env.OPENPLC_URL ?? "").replace(/\/+$/, "");
const plcUser = process.env.OPENPLC_USER ?? "";
const plcPass = process.env.OPENPLC_PASSWORD ?? "";
const insecure = process.env.OPENPLC_INSECURE_TLS === "true";
const dispatcher = insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

if (!plcUrl || !plcUser || !plcPass) {
  row(false, "openplc env", `missing ${[!plcUrl && "OPENPLC_URL", !plcUser && "OPENPLC_USER", !plcPass && "OPENPLC_PASSWORD"].filter(Boolean).join(", ")}`);
} else {
  info(`OpenPLC @ ${plcUrl} (user ${plcUser}, insecure TLS ${insecure})`);
  let token: string | null = null;
  try {
    const r = await getText(`${plcUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: plcUser, password: plcPass }),
      ...(dispatcher && { dispatcher }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const body = JSON.parse(r.text) as { access_token?: string };
    token = body.access_token ?? null;
    if (!token) throw new Error(`no access_token in response (keys: ${Object.keys(body).join(", ")})`);
    row(true, "openplc login", "JWT received");
  } catch (err) {
    row(false, "openplc login", why(err));
  }
  if (token) {
    const auth = { authorization: `Bearer ${token}` };
    for (const [name, path, expect] of [
      ["openplc ping", "/api/ping", /PING:OK/],
      ["openplc status", "/api/status", /STATUS:/],
    ] as const) {
      try {
        const r = await getText(`${plcUrl}${path}`, { headers: auth, ...(dispatcher && { dispatcher }) });
        const body = r.text.trim().slice(0, 200);
        row(r.ok && expect.test(body), name, `HTTP ${r.status} ${body}`);
      } catch (err) {
        row(false, name, why(err));
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// 2. Factory I/O tags vs scene
// ------------------------------------------------------------------------------------------------
interface FioTag { name: string; id: string; type: string; kind: string; value: unknown; isForced?: boolean; forcedValue?: unknown }
interface SceneTag { name: string; role: string; fioKind?: string; webApiId?: string }

const fioUrl = (process.env.FACTORYIO_URL ?? "").replace(/\/+$/, "");
let sceneTags: SceneTag[] = [];
try {
  sceneTags = (JSON.parse(readFileSync(SCENE_FILE, "utf8")) as { tags: SceneTag[] }).tags;
} catch (err) {
  row(false, "scene file", `${SCENE_FILE}: ${why(err)}`);
}

let rigTags: FioTag[] | null = null;
if (!fioUrl) {
  row(false, "factoryio env", "missing FACTORYIO_URL");
} else {
  info(`Factory I/O @ ${fioUrl}`);
  try {
    const r = await getText(`${fioUrl}/api/tags`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const parsed = JSON.parse(r.text) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`expected an array, got ${r.text.slice(0, 120)}`);
    const tags = parsed as FioTag[];
    rigTags = tags;
    row(true, "factoryio tags", `${tags.length} tags`);

    const kinds = [...new Set(tags.map((t) => JSON.stringify(t.kind)))];
    const types = [...new Set(tags.map((t) => JSON.stringify(t.type)))];
    info(`kind values on rig: ${kinds.join(", ")}   type values: ${types.join(", ")}`);
    const sceneKinds = [...new Set(sceneTags.map((t) => JSON.stringify(t.fioKind)))];
    const kindCaseMatches = sceneTags.every((t) => !t.fioKind || tags.some((x) => String(x.kind).toLowerCase() === t.fioKind!.toLowerCase()));
    row(kindCaseMatches, "kind case", `scene fioKind ${sceneKinds.join(", ")} vs rig ${kinds.join(", ")}${kindCaseMatches ? "" : " — MISMATCH (case-insensitive)"}`);

    const running = tags.find((t) => t.name === "FACTORY I/O (Running)" && String(t.kind).toLowerCase() === "input");
    row(running ? running.value === true : false, "scene running", running ? `FACTORY I/O (Running) = ${JSON.stringify(running.value)}` : "no FACTORY I/O (Running) input tag");

    if (sceneTags.length) {
      const byName = new Map<string, FioTag[]>();
      for (const t of tags) byName.set(t.name, [...(byName.get(t.name) ?? []), t]);
      const missing = sceneTags.filter((t) => !byName.has(t.name)).map((t) => t.name);
      const kindDiff = sceneTags
        .filter((t) => t.fioKind && byName.has(t.name) && !byName.get(t.name)!.some((x) => String(x.kind).toLowerCase() === t.fioKind!.toLowerCase()))
        .map((t) => `${t.name} (scene ${t.fioKind}, rig ${byName.get(t.name)!.map((x) => x.kind).join("/")})`);
      const idDiff = sceneTags
        .filter((t) => t.webApiId && byName.has(t.name) && !byName.get(t.name)!.some((x) => x.id === t.webApiId))
        .map((t) => t.name);
      row(missing.length === 0, "scene tags", missing.length ? `${missing.length}/${sceneTags.length} missing on rig: ${missing.join(", ")}` : `all ${sceneTags.length} present on rig`);
      if (kindDiff.length) info(`kind mismatch (exact compare): ${kindDiff.join("; ")}`);
      if (idDiff.length) info(`webApiId differs from rig id: ${idDiff.join(", ")}`);
      const forced = tags.filter((t) => t.isForced).map((t) => `${t.name}[${t.kind}]=${JSON.stringify(t.forcedValue)}`);
      if (forced.length) info(`forced on rig: ${forced.join(", ")}`);
    }
  } catch (err) {
    row(false, "factoryio tags", why(err));
  }
}

// ------------------------------------------------------------------------------------------------
// 3. Current values of all scene tags — one GET /api/tag/values (no body → every tag; filtered here)
// ------------------------------------------------------------------------------------------------
if (rigTags && sceneTags.length) {
  try {
    const r = await getText(`${fioUrl}/api/tag/values`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const values = JSON.parse(r.text) as { id: string; value: unknown; error?: string; code?: number }[];
    const errs = values.filter((v) => v?.error);
    const byId = new Map(values.map((v) => [v.id, v.value]));
    const lines: string[] = [];
    let unresolved = 0;
    for (const st of sceneTags) {
      const matches = rigTags.filter((t) => t.name === st.name);
      const want = (st.fioKind ?? (st.role === "actuator" ? "output" : "input")).toLowerCase();
      const tag = matches.find((t) => String(t.kind).toLowerCase() === want) ?? matches[0];
      if (!tag || !byId.has(tag.id)) {
        unresolved++;
        lines.push(`${st.name}=<n/a>`);
      } else lines.push(`${st.name}=${JSON.stringify(byId.get(tag.id))}`);
    }
    row(errs.length === 0 && unresolved === 0, "tag values", `${values.length} values returned, ${sceneTags.length - unresolved}/${sceneTags.length} scene tags read${errs.length ? `, ${errs.length} item errors: ${errs.slice(0, 3).map((e) => `${e.code} ${e.error}`).join("; ")}` : ""}`);
    for (const l of lines) info(l);
  } catch (err) {
    row(false, "tag values", why(err));
  }
} else if (fioUrl) {
  row(false, "tag values", "skipped (tag list or scene file unavailable)");
}

await dispatcher?.close().catch(() => {});
process.exit(failed ? 1 : 0);
