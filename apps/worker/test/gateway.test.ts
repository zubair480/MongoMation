// Team gateway: X-Team-Key must reach every OpenPLC + Factory I/O request, and path-prefixed base URLs
// (https://<gw>/openplc, https://<gw>/factoryio) must keep their prefix without double slashes.
import { strict as assert } from "node:assert";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fioRequest } from "../src/tools/factoryio.ts";
import { OpenPlcRest } from "../src/tools/openplc.ts";

const KEY = "test-team-key";
const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url ?? "", headers: req.headers });
  if (req.headers["x-team-key"] !== KEY) return void res.writeHead(401).end("missing or wrong X-Team-Key");
  res.setHeader("content-type", "application/json");
  if (req.url === "/openplc/api/login") return void res.end(JSON.stringify({ access_token: "jwt" }));
  if (req.url === "/openplc/api/status") return void res.end(JSON.stringify({ status: "STATUS:RUNNING" }));
  if (req.url === "/factoryio/api/tags") return void res.end("[]");
  res.writeHead(404).end("{}");
});
let base = "";

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

describe("team gateway", () => {
  it("OpenPLC sends X-Team-Key on login and API calls under the /openplc prefix", async () => {
    seen.length = 0;
    const plc = new OpenPlcRest(`${base}/openplc/`, "u", "p", "v4", undefined, false, undefined, KEY);
    const s = await plc.status();
    assert.equal(s.running, true, s.detail);
    assert.deepEqual(seen.map((r) => r.url), ["/openplc/api/login", "/openplc/api/status"]);
    assert.ok(seen.every((r) => r.headers["x-team-key"] === KEY));
    assert.equal(seen[1].headers.authorization, "Bearer jwt");
  });

  it("OpenPLC without the key is rejected by the gateway (no header sent)", async () => {
    seen.length = 0;
    const s = await new OpenPlcRest(`${base}/openplc`, "u", "p", "v4").status();
    assert.equal(s.reachable, false);
    assert.equal(seen[0].headers["x-team-key"], undefined);
  });

  it("Factory I/O fioRequest keeps the /factoryio prefix and sends X-Team-Key", async () => {
    seen.length = 0;
    for (const b of [`${base}/factoryio`, `${base}/factoryio/`]) {
      const r = await fioRequest(b, "GET", "/api/tags", { teamKey: KEY });
      assert.equal(r.status, 200);
    }
    assert.deepEqual(seen.map((r) => r.url), ["/factoryio/api/tags", "/factoryio/api/tags"]);
    assert.ok(seen.every((r) => r.headers["x-team-key"] === KEY));
  });
});
