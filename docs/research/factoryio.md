# Factory I/O developer reference for MongoMation

How a Node/TypeScript service talks to the Factory I/O Web API, and how OpenPLC talks to Factory I/O over Modbus TCP.

Researched 2026-10-11. The current Factory I/O release is **2.5.10**, an OPC UA hotfix dated 2025-10-15 [OFFICIAL: release notes].

## How this was researched (read first)

This sandbox could not open docs.factoryio.com, community.factoryio.com or factoryio.helpscoutdocs.com directly, because the egress proxy blocked them. Their content came in two ways:

1. **Search-engine extracts of those exact official pages**, cross-checked against the primary artifacts below.
2. **Primary artifacts read directly:**
   - Real Games' own SDK repository (`realgamessoftware/factoryio-sdk`), fetched from GitHub.
   - A verbatim OpenAPI transcription of the official Web API page (`api-evangelist/factory-i-o`, `openapi/_original/factory-i-o-web-api.yaml`), which links back to docs.factoryio.com/manual/web-api/. Its endpoints, examples and error strings match the search extracts of the official page.
   - Real `.factoryio` scene files. These are XML written by Factory I/O 2.2.3 through 2.5.10, taken from public GitHub repos.
   - A real `config.cfg` written by Factory I/O 2.5.x.
   - Runtime tag captures from 18 built-in scenes (SCAPHY dataset, IEEE S&P 2023).
   - The OpenPLC_v3 source code.

Legend:

| Tag | Meaning |
|---|---|
| `[OFFICIAL]` | Real Games docs, help center, release notes, editions page, or the Real Games SDK repo |
| `[SCENE-FILE]` | Read directly from `.factoryio` XML saved by Factory I/O |
| `[OBSERVED]` | Runtime capture or working third-party code |
| `[INFERRED]` | Logical conclusion from the sources above; not stated anywhere |
| `[UNVERIFIED]` | Plausible but unconfirmed; test it on your install |

---

## 0. TL;DR: the 15 facts that will bite you

1. **Edition and enabling.** The Web API needs the **Ultimate Edition**. The 30-day trial is full Ultimate.
   - Turn the web server on with the console command `app.web_server = True`. Put it in `auto.cfg` to make it automatic.
   - The server first appeared, as experimental, in **2.4.6** (Jan 2021). The force, release and always-on/off verbs were added in **2.5.2** (Aug 2022). [OFFICIAL]
2. **URL and security.** The default URL is `http://*:7410` (`app.web_server_url`, which must be set *before* enabling). No authentication, TLS, CORS or rate limits are documented. [OFFICIAL; the absence of auth is INFERRED]
3. **Sensors cannot be written.** Sensor tags (kind `Input`) reject `PUT /api/tag/values` with a per-item `406 "Not allowed to set value of an input tag."` [OFFICIAL]
   - To "press" a button or fake a sensor, use `PUT /api/tag/values-force`, then `PUT /api/tag/values-release`. [OFFICIAL + community]
   - Push buttons, selectors and potentiometers are all Inputs.
4. **The driver overwrites mapped actuators.** When a driver maps an actuator tag (kind `Output`), the PLC overwrites anything written through the Web API on every I/O exchange. Use force to override an actuator. [OBSERVED: community thread on 2.5.1. Official: "Forcing an actuator's tag will override the value read from the controller."]
5. **Errors are per item.** Batch calls return HTTP 200 with errors inside the array as `{code, error}`. Check every item. [OFFICIAL]
6. **Names are not unique.**
   - `FACTORY I/O (Reset)` exists as both an Input and an Output.
   - Sorting by Weight has `Weight` as both an Input Float (the scale) and an Output Int (the display), plus three Outputs named `Remover`.
   - Resolve IDs once from `GET /api/tags` by **(name, kind)**, then use the ID endpoints. [OFFICIAL + OBSERVED]
7. **Tag IDs are stable.** IDs are GUIDs stored in the scene file. For built-in scenes they are identical across copies saved with 2.2.3, 2.5.4, 2.5.7 and 2.5.10. [SCENE-FILE]
   - The official docs' example IDs come from Sorting by Height (Basic): `01936c60-…` is `FACTORY I/O (Reset)` (Output) and `df43b72e-…` is `Stop`.
8. **`address` is not a Modbus address.** It is Factory I/O's internal I/O-point index per (kind, type).
   - System tags sit at bit 496/497/498 and numeric 240.
   - For a Modbus address, export the driver's tag list. [OFFICIAL SDK `RESERVED ADDRESSES.md` + SCENE-FILE]
9. **Sensor and button polarity.**
   - Retroreflective sensors read **TRUE when the beam is clear** and FALSE when a box blocks it. Examples: `Sensor` in From A to B, and `At left entry`/`At right exit` in Sorting by Height.
   - Diffuse sensors (`High sensor`, `Low sensor`, `Pallet sensor`) read TRUE when they detect something.
   - **`Stop` and `Emergency stop` are NC** (TRUE at rest). `Start` and `Reset` are NO. The Auto/Manual selector rests on `Manual`.
   - [OBSERVED in captures, consistent with the official SDK sample logic. The NC Stop and E-stop are OFFICIAL.]
10. **Emitters and removers are pre-forced.** Built-in scenes ship with the Emitter/Remover actuator tags **pre-forced TRUE**, which is why boxes appear and vanish without PLC logic. A blanket "release all forces" stops box generation. [SCENE-FILE]
    - Seen in Sorting by Height Basic and Advanced, Sorting by Weight, Queue of Items, Buffer Station, Converge Station, Separating Station, Sorting Station, Pick & Place, Assembler and Palletizer.
11. **Simulation control works through system tags.**
    - `FACTORY I/O (Run)` (Output) needs a **rising edge** to enter Run mode. The SDK writes false, waits 500 ms, then writes true. Writing false returns the scene to Edit mode.
    - `FACTORY I/O (Pause)` and `FACTORY I/O (Reset)` are also Outputs.
    - There is no Web API call to load a scene. Use the command line (`"Factory IO.exe" "load:<path>" run`) or `auto.cfg`. [OFFICIAL]
12. **Node `fetch` cannot send a body with GET.** Use `GET /api/tag/values` with no body (it returns all values) and filter on the client, or call `GET /api/tags`.
13. **Topology.** Use Factory I/O **Modbus TCP/IP Server** as the slave and OpenPLC (v3) as the master, with a "Generic Modbus TCP Device" slave device. [OFFICIAL OpenPLC UI text]
    - Discrete Inputs map to `%IX100.0…`, Coils to `%QX100.0…`, Input Registers to `%IW100…`, and Holding Registers (write) to `%QW100…`.
    - OpenPLC polls every 100 ms by default. [OpenPLC_v3 source]
14. **Default Modbus layout.** Built-in scenes ship with a default Modbus layout: process sensors first, then panel inputs, then `FACTORY I/O (Running)` as discrete inputs; actuators then lights as coils; displays as holding registers. [SCENE-FILE]
15. **Windows only.** Factory I/O needs a DirectX 10/11/12 GPU. On a cloud VM, use a GPU instance with Amazon DCV (or similar), and set `input.force_alternative_mouse_data = True` if the camera won't move. [OFFICIAL]

---

## 1. Factory I/O Web API

Primary page: https://docs.factoryio.com/manual/web-api/

Transcription: https://raw.githubusercontent.com/api-evangelist/factory-i-o/main/openapi/_original/factory-i-o-web-api.yaml

### 1.1 Requirements and enabling

| Item | Value | Status |
|---|---|---|
| Edition | **Ultimate Edition** ("This functionality requires the Ultimate Edition"). The 30-day trial is full Ultimate. | [OFFICIAL] |
| Introduced | 2.4.6 (2021-01-26), "experimental" embedded HTTP server, with the 7 read/write endpoints | [OFFICIAL] |
| Force/release/always-on/off | Added in **2.5.2** (2022-08-08): "Added Web API PUT verbs for forcing tag values and injecting always on/off failures" | [OFFICIAL] |
| Enable | Console: `app.web_server = True` (bool, default False, "runs a web server in the background") | [OFFICIAL] |
| URL/port | `app.web_server_url`, a string, default `r'http://*:7410'`. "Must be set before starting the server." | [OFFICIAL console page; the same default appears in a real 2.5.x `config.cfg`] |
| Default bind | The 2.4.6 preview post said "listens at the loopback address on port 7410". The current console default `http://*:7410` means all interfaces. Remote access is used in practice (`host.docker.internal:7410` and LAN IPs in public projects). | [OFFICIAL + OBSERVED] |
| Base URL | `http://<factory-io-host>:7410/api/...` | [OFFICIAL] |
| Auth / TLS | None documented. Treat port 7410 as unauthenticated full control: firewall it, or bind it to a private IP / VPN. | [INFERRED] |
| CORS | Not documented. Call it server-to-server from Node and proxy it for browser UIs. | [UNVERIFIED] |
| Rate limits | None documented. Public clients poll every 20–300 ms. | [OBSERVED] |
| Windows firewall | Allow inbound TCP 7410 (and 502 for Modbus). An `http://*:port` bind may need admin rights or a URL ACL if it is HttpListener-based. | [UNVERIFIED] |
| Persistence | `app.web_server` and `app.web_server_url` appear as keys in `config.cfg`, which Factory I/O writes on exit. Still, put them in `auto.cfg` to be deterministic. | [OBSERVED] |

Recommended `auto.cfg`. Place it in `C:\ProgramData\Real Games\Factory IO\auto.cfg`, the recommended global location since 2.4.0 [OFFICIAL]:

```
ui.show_welcome_window = False
app.web_server_url = r'http://*:7410'
app.web_server = True
scene.load_from_path(r'C:\Users\<you>\Documents\Factory IO\My Scenes\Sorting by Height (Basic) MM.factoryio')
scene.start_in_run_mode = True
drivers.modbustcp_server.port = 502
drivers.modbustcp_server.slave_id = 1
drivers.modbustcp_server.auto_connect = True
input.force_alternative_mouse_data = True
```

- All of these keys appear in official docs or in real `auto.cfg`/`config.cfg` files [OFFICIAL / OBSERVED].
- `drivers.modbustcp_server.network_adapter = r'<adapter name>'` also exists [OBSERVED in config.cfg].
- The *selected* driver (Modbus TCP/IP Server, for example) is saved inside the scene file (`<Drivers CurrentDriver="…">`). Save your scene to My Scenes with the driver already selected. [SCENE-FILE]

### 1.2 Endpoint table

Notes for every endpoint:

- Send JSON with `Content-Type: application/json`.
- "Per-item result" means the response is HTTP 200 with an array. It contains `{id|name, value}` for successful reads and `{id|name, code, error}` for failed items. PUTs return *only* the failed items, so an empty array means every item succeeded. [OFFICIAL]
- A 2.5.1 user saw an **empty HTTP body** on PUT, so parse the response defensively. [OBSERVED]

| # | Method | Path | Body | Response | Since |
|---|---|---|---|---|---|
| 1 | GET | `/api/tags` | none. Query: `name` (case-insensitive, `*` and `?` wildcards, e.g. `?name=*reset*`), `type` = `bit\|int\|float`, `kind` = `input\|output` | `Tag[]` (system tags included) | 2.4.6 |
| 2 | GET | `/api/tags/{id}` | none | `Tag`, or 404 | 2.4.6 |
| 3 | GET | `/api/tags/by-name/{name}` | none. URL-encode the name, so `/` becomes `%2F` (docs example: `FACTORY I%2FO (Reset)`) | `Tag[]` (names are not unique) | 2.4.6 |
| 4 | GET | `/api/tag/values` | optional `["<id>", …]`. **Omit the body to get all tags.** | `[{"id","value"} \| {"id","code","error"}]` | 2.4.6 |
| 5 | PUT | `/api/tag/values` | `[{"id":"<id>","value":true\|123\|3.14}]` | per-item errors | 2.4.6 |
| 6 | GET | `/api/tag/values/by-name` | optional `["<name>", …]`. Omit it to get all tags. | `[{"name","value"} \| {"name","code","error"}]` | 2.4.6 |
| 7 | PUT | `/api/tag/values/by-name` | `[{"name":"<name>","value":…}]` | per-item errors | 2.4.6 |
| 8 | PUT | `/api/tag/values-force` | `[{"id":"<id>","value":…}]` | per-item errors | 2.5.2 |
| 9 | PUT | `/api/tag/values-force/by-name` | `[{"name":"<name>","value":…}]` | per-item errors | 2.5.2 |
| 10 | PUT | `/api/tag/values-release` | `["<id>", …]` | per-item errors | 2.5.2 |
| 11 | PUT | `/api/tag/values-release/by-name` | `["<name>", …]` | per-item errors | 2.5.2 |
| 12 | PUT | `/api/tag/values-alwaysoff` | `[{"id":"<id>","value":true}]` sets the Always Off failure (open circuit). `false` presumably clears it [INFERRED]. | per-item errors | 2.5.2 |
| 13 | PUT | `/api/tag/values-alwaysoff/by-name` | `[{"name":"<name>","value":true}]` | per-item errors | 2.5.2 |
| 14 | PUT | `/api/tag/values-alwayson` | `[{"id":"<id>","value":true}]` sets the Always On failure (short circuit). For Int/Float tags it saturates the value. | per-item errors | 2.5.2 |
| 15 | PUT | `/api/tag/values-alwayson/by-name` | `[{"name":"<name>","value":true}]` | per-item errors | 2.5.2 |

There are no endpoints for scenes, drivers, connection status, camera control or time. Use the system tags in section 1.6. [OFFICIAL: the endpoint list is complete as published]

Documented per-item error codes [OFFICIAL]:

| code | error text (examples from the docs) | cause |
|---|---|---|
| 404 | `Tag with id 'df43b72e-992a-4936-9d46-32764400b933' not found.` / `Tag named 'Name of non-existing tag' not found.` | Unknown ID or name in the loaded scene |
| 406 | `Not allowed to set value of an input tag.` | `PUT /api/tag/values*` on a sensor (Input) tag |
| 406 | `Could not convert value to the tag data type: Bit.` | Wrong JSON type for the tag |

Top-level errors use 4xx for client errors and 5xx for "errors in Factory I/O", with body `{"code":<int>,"error":"<msg>"}`. [OFFICIAL]

### 1.3 Tag JSON shape

Example taken verbatim from the docs. The tag is the "FACTORY I/O (Reset)" system Output [OFFICIAL]:

```json
{
  "name": "FACTORY I/O (Reset)",
  "id": "01936c60-0201-4d54-aad2-0734eb391d35",
  "address": 498,
  "type": "Bit",
  "kind": "Output",
  "value": false,
  "openCircuit": false,
  "shortCircuit": false,
  "isForced": false,
  "forcedValue": false
}
```

```ts
// Matches the official schema and an independent TS client (ioloEJ42/FactoryIO-Interface)
export type TagType = "Bit" | "Int" | "Float";   // query filters use lowercase: bit|int|float
export type TagKind = "Input" | "Output";        // query filters use lowercase: input|output
export interface FioTag {
  name: string;            // NOT unique
  id: string;              // GUID, stable per scene (stored in the .factoryio file)
  address: number;         // internal I/O point index per (kind,type); NOT a Modbus address
  type: TagType;           // Bit -> boolean, Int -> integer, Float -> number
  kind: TagKind;           // from the CONTROLLER's point of view
  value: boolean | number;
  openCircuit: boolean;    // Always Off failure active
  shortCircuit: boolean;   // Always On failure active
  isForced: boolean;
  forcedValue: boolean | number;
}
```

Field semantics:

- **`kind` is seen from the controller's point of view** [OFFICIAL]:
  - `Input` = data going to the PLC: **sensors**, plus push buttons, selector switches, potentiometers, and the status tags `FACTORY I/O (Running|Paused|Reset|Time Scale)`.
  - `Output` = data coming from the PLC: **actuators**, plus lights, digital displays, emitters/removers (when tag-controlled) and the command tags `FACTORY I/O (Run|Pause|Reset|Camera Position)`.
  - The SDK README says: "Standing from a controller point of view, Inputs are used to read sensors values, Outputs to write actuators."
- **`type`.** The UI and driver exports call these `Bool`/`Int`/`Float` (`Real` in Modbus CSV exports). The Web API calls them `Bit`/`Int`/`Float`. [OFFICIAL]
- **`address`** is the internal memory-map index. In the docs examples, "FACTORY I/O (Reset)" is 498 and "Left conveyor" (Sorting by Weight) is 8.
  - This matches the scene XML `Address` attribute and the SDK reserved addresses: Input bits 496 Running, 497 Paused, 498 Reset, and Float 240 Time Scale; Output bits 496 Run, 497 Pause, 498 Reset, and Int 240 Camera.
  - [OFFICIAL SDK + SCENE-FILE; the equivalence to the API field is INFERRED]
- **`value` while forced.** It is not documented whether `value` reports the forced value or the physical value. Read `isForced`/`forcedValue` explicitly. [UNVERIFIED]

### 1.4 Request and response examples

```bash
B=http://FIO_HOST:7410

# list all sensor tags whose name contains "sensor"
curl "$B/api/tags?kind=input&name=*sensor*"

# read ALL values (no body). Use this from Node.
curl "$B/api/tag/values"
# -> [{"id":"52052c12-f2ba-4289-a574-9ba7bd5ac0a2","value":false}, ...]

# read selected values by name (GET with a body works from curl/axios-in-node, not from fetch)
curl -X GET -H 'Content-Type: application/json' -d '["High sensor","Counter"]' "$B/api/tag/values/by-name"
# -> [{"name":"High sensor","value":false},{"name":"Counter","value":3}]

# write an actuator (only sticks if no driver maps it)
curl -X PUT -H 'Content-Type: application/json' -d '[{"name":"Conveyor entry","value":true}]' "$B/api/tag/values/by-name"

# writing a sensor fails per item
curl -X PUT -H 'Content-Type: application/json' -d '[{"name":"High sensor","value":true}]' "$B/api/tag/values/by-name"
# -> [{"name":"High sensor","code":406,"error":"Not allowed to set value of an input tag."}]

# FORCE a sensor (fault injection), then RELEASE it
curl -X PUT -H 'Content-Type: application/json' -d '[{"id":"52052c12-f2ba-4289-a574-9ba7bd5ac0a2","value":true}]' "$B/api/tag/values-force"
curl -X PUT -H 'Content-Type: application/json' -d '["52052c12-f2ba-4289-a574-9ba7bd5ac0a2"]' "$B/api/tag/values-release"

# by-name variants
curl -X PUT -H 'Content-Type: application/json' -d '[{"name":"At left entry","value":false}]' "$B/api/tag/values-force/by-name"
curl -X PUT -H 'Content-Type: application/json' -d '["At left entry"]' "$B/api/tag/values-release/by-name"

# hardware-style failures (shown as failure icons in the UI)
curl -X PUT -H 'Content-Type: application/json' -d '[{"name":"Low sensor","value":true}]' "$B/api/tag/values-alwayson/by-name"
curl -X PUT -H 'Content-Type: application/json' -d '[{"name":"Low sensor","value":false}]' "$B/api/tag/values-alwayson/by-name"   # clear [INFERRED]
```

### 1.5 Behavior details that matter for MongoMation

- **Pressing a virtual button.** Buttons are Input tags, so you cannot write them; force them instead. [OFFICIAL + OBSERVED]
  - NO buttons (`Start`, `Reset`): force `true`, hold, release.
  - NC buttons (`Stop`, `Emergency stop`): force `false`, hold, release.
  - Hold for at least the OpenPLC slave polling period (100 ms default) plus the PLC scan cycle, plus margin. **300–500 ms** is safe. [INFERRED]
- **Auto mode.** The Auto/Manual selector rests on `Manual` in the default layouts [OBSERVED].
  - If the generated PLC code requires Auto, force `Auto=true` and `Manual=false` for the duration of a test, or click the selector in the UI.
- **Forced values reach the PLC.** "Even if a sensor is not detecting an item, forcing its value will make it to be sent to the controller." The forced value therefore travels over Modbus to OpenPLC. [OFFICIAL]
- **Forcing an actuator** "will override the value read from the controller". Use it to simulate a stuck motor or valve. [OFFICIAL]
- **Driver overwrite.** With a driver connected, Web API *writes* to driver-mapped Output tags are overwritten on the next I/O exchange (2.5.1 report: "PUT requests no longer changed the tag"). [OBSERVED]
  - Writes to Output tags the driver does not map (for example `FACTORY I/O (Run)`, which isn't in the default Modbus map) do work. They were used together with the Modbus Server driver in nesfit/bonnet-ics-library. [OBSERVED]
- **Pre-forced tags.** At scene load, Emitter/Remover tags are already `isForced=true, forcedValue=true` (section 4).
  - To pause box generation, force `Emitter=false`; force it back to `true` to resume. Releasing it hands it back to the PLC or driver, which is usually unmapped and therefore false. [SCENE-FILE + INFERRED]
- **Persistence.** Forced state is persisted *in the scene file* if you save the scene (`UseForcedValue`/`ForcedValue` attributes). Release your fault forces before saving. [SCENE-FILE]
- **Measurements.** One `GET /api/tags` per tick returns values plus `isForced`/`openCircuit`/`shortCircuit` for every tag, including tags not mapped to Modbus.
  - Values only change while the scene runs (Running = true).
  - Responses carry no timestamp, so stamp them client-side, and use `FACTORY I/O (Time Scale)` to detect pause (0), slow motion (0.1) and fast-forward (2/3/4). [OFFICIAL tags doc]
- **Alternative logger.** The console offers `scene.start_tag_export([file_name,] interval)` / `scene.stop_tag_export()` for a periodic CSV export. [OFFICIAL console; CSV columns UNVERIFIED]

### 1.6 Simulation control through the API (system tags)

Official semantics [OFFICIAL tags doc + SDK]:

| Tag | Kind/Type | Meaning |
|---|---|---|
| `FACTORY I/O (Running)` | Input Bit (addr 496) | true when the simulation is in Run mode |
| `FACTORY I/O (Paused)` | Input Bit (497) | true while paused |
| `FACTORY I/O (Reset)` | Input Bit (498) | true for 1 s when the scene is reset |
| `FACTORY I/O (Time Scale)` | Input Float (240) | 0 = paused/edit, 0.1 = slow motion, 1 = run, 2/3/4 = fast-forward |
| `FACTORY I/O (Run)` | Output Bit (496) | switches Edit/Run. The SDK forces a **rising edge** (false, 500 ms, true, 500 ms). Setting it false returns to Edit (SDK `Shutdown`; bonnet scripts). |
| `FACTORY I/O (Pause)` | Output Bit (497) | pause |
| `FACTORY I/O (Reset)` | Output Bit (498) | reset the scene (use a pulse) [edge behavior INFERRED] |
| `FACTORY I/O (Camera Position)` | Output Int (240) | jump to a saved camera position |

The Output IDs below are identical in every scene file inspected (From A to B, Filling Tank, Level Control, Sorting by Height Basic) [SCENE-FILE]:

- Run `7754fab1-ed21-4fca-9ab9-45e844cd4766`
- Pause `41b90af6-25d1-4fa8-aaec-724f79701be1`
- Reset `01936c60-0201-4d54-aad2-0734eb391d35`
- Camera `f0855715-c7e4-48b3-8174-0fc06299798c`

The Input-side IDs differ per scene, so still resolve all IDs from `/api/tags`.

### 1.7 Minimal TypeScript client (Node 18+)

```ts
const BASE = process.env.FIO_URL ?? "http://FIO_HOST:7410";
type Item = { id?: string; name?: string; value?: boolean | number; code?: number; error?: string };

async function call(method: "GET" | "PUT", path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, // never a body on GET with fetch
  });
  const text = await r.text();                     // PUT may return [] or an empty body
  const json = text ? JSON.parse(text) : [];
  if (!r.ok) throw new Error(`FIO ${r.status}: ${json?.error ?? text}`);
  const errs = Array.isArray(json) ? (json as Item[]).filter(i => i.error) : [];
  if (errs.length) throw new Error("FIO item errors: " + JSON.stringify(errs));
  return json;
}

export async function loadIndex() {
  const tags: FioTag[] = await call("GET", "/api/tags");
  const key = (n: string, k: TagKind) => `${k}:${n}`;
  const byKey = new Map(tags.map(t => [key(t.name, t.kind), t]));
  return (name: string, kind: TagKind) => {
    const t = byKey.get(key(name, kind));
    if (!t) throw new Error(`tag not found: ${kind} ${name}`);
    return t.id;
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const readAll = () => call("GET", "/api/tag/values") as Promise<{ id: string; value: boolean | number }[]>;
export const force   = (id: string, value: boolean | number) => call("PUT", "/api/tag/values-force", [{ id, value }]);
export const release = (...ids: string[]) => call("PUT", "/api/tag/values-release", ids);
export async function pressButton(id: string, pressedValue = true, holdMs = 400) {
  await force(id, pressedValue);   // NO button: true, NC button (Stop/E-stop): false
  await sleep(holdMs);
  await release(id);
}
export async function runScene(runId: string) {   // rising edge on FACTORY I/O (Run) Output
  await call("PUT", "/api/tag/values", [{ id: runId, value: false }]);
  await sleep(500);
  await call("PUT", "/api/tag/values", [{ id: runId, value: true }]);
}
```

---

## 2. Command line, console, auto.cfg, keyboard

### 2.1 Command-line arguments

Official help article "Command-line arguments": https://factoryio.helpscoutdocs.com/article/21-command-line-arguments. It lists exactly **three** arguments [OFFICIAL]:

| Argument | Effect |
|---|---|
| `load:<path-to-scene>` | load a scene at startup |
| `run` | start the scene in Run mode (added in 2.2.2) |
| `feed` | override the feed used to populate the Welcome window (exact syntax not retrieved) |

```
"Factory IO.exe" "load:C:\Users\me\Documents\Factory IO\My Scenes\SBH MM.factoryio" run
```

This form follows the "Load a scene at startup" article (https://factoryio.helpscoutdocs.com/article/22-load-scene-at-startup and community.factoryio.com/t/26).

- **There are no CLI flags** for the web server, driver selection or console. Use `auto.cfg` and console commands instead (section 2.2). The driver selection lives in the scene file. [OFFICIAL + SCENE-FILE]
- Typical install path: `C:\Program Files (x86)\Real Games\Factory IO\Factory IO.exe` [UNVERIFIED].
- Silent install: `factoryio-2.X.XX.exe --mode unattended` [OFFICIAL help center "Install in silent mode"].
- No headless or batch mode is documented. Factory I/O is a 3D app and needs a GPU and a desktop session. [INFERRED]

### 2.2 auto.cfg and config.cfg

Source: https://docs.factoryio.com/manual/console/ and help article 20.

- **Locations for `auto.cfg`** [OFFICIAL]:
  - The installation folder.
  - `C:\ProgramData\Real Games\Factory IO\` (the recommended global location since 2.4.0). The install-folder and ProgramData copies run for every Windows account.
  - `Documents\Factory IO\` (per user, executed afterwards, so it overrides).
- **What can go in it.** Any console command or setting.
- **Load order** per the help center: user `config.cfg`, then the global `auto.cfg`, then the per-user `auto.cfg`.
- **`config.cfg`** is written by Factory I/O on shutdown to persist settings. A real one contains for example:
  - `app.web_server_url = r'http://*:7410'`, `app.web_server = False`
  - `drivers.modbustcp_server.port = 502`, `.network_adapter = r''`, `.slave_id = 1`, `.auto_connect = True`
  - `drivers.modbustcp_client.ip_address/port/slave_id/auto_connect`
  - `video.quality = r'Very Low'`, `video.target_fps = 60`, `scene.max_item_count = 500`, `ui.show_welcome_window = False`
  - `license.share_code = ''`
  - [OBSERVED: nobrackets-ctf/NoBrackets-2024 `src/config.cfg`]

### 2.3 Console commands relevant here

Open the console with `\` (backslash) or VIEW > Open Console. [OFFICIAL]

| Command | Type / default | Purpose | Status |
|---|---|---|---|
| `app.web_server` | bool / False | start the embedded web server (Ultimate) | OFFICIAL |
| `app.web_server_url` | string / `r'http://*:7410'` | bind URL; set before enabling | OFFICIAL |
| `scene.load_from_path(r'<path>')` | void | load a scene. Use `r'...'` or doubled backslashes. Works in auto.cfg (fixed in a release). | OFFICIAL |
| `scene.start_in_run_mode` | bool / False | start loaded scenes in Run mode | OFFICIAL |
| `scene.time_scale` | float / 0.1 | slow-motion factor ("use with care") | OFFICIAL |
| `scene.export_tags_csv(file_name=None, valid_iec_identifiers=False)` | void | export the tag list to CSV in `Documents\Factory IO\` | OFFICIAL |
| `scene.start_tag_export(interval)` / `scene.start_tag_export(file_name, interval)` / `scene.stop_tag_export()` | void | periodic CSV export of tag values | OFFICIAL (format UNVERIFIED) |
| `scene.my_scenes_path`, `scene.max_item_count`, `scene.debug_sensor_range`, `scene.debug_emitter_remover` | various | scene settings | OBSERVED in config.cfg |
| `drivers.modbustcp_server.auto_connect` / `.port` (502) / `.slave_id` (1) / `.network_adapter` | | Modbus server settings. auto_connect "automatically start the server". | OFFICIAL (network_adapter OBSERVED) |
| `drivers.modbustcp_client.ip_address` / `.port` / `.slave_id` / `.auto_connect` | | Modbus client settings | OBSERVED |
| `input.force_alternative_mouse_data` | bool / False | fixes camera/mouse in a VM or remote desktop | OFFICIAL |
| `ui.show_welcome_window` | bool | suppress the welcome window for automation | OBSERVED |
| `app.quit()` / `app.force_quit()` | void | quit, or quit without the unsaved-changes prompt (moved from `scene.*` in 2.4.4) | OFFICIAL |
| `app.run_in_background` | bool | **deprecated in 2.4.0**. Factory I/O always keeps running when it loses focus. | OFFICIAL |
| `license.share_code = '<code>'` | string | floating-license activation through auto.cfg | OFFICIAL / OBSERVED |
| `video.quality`, `video.target_fps`, `video.vsync`, `video.resolution`, `video.fullscreen` | | reduce GPU load on a VM | OBSERVED |

### 2.4 Keyboard shortcuts

From the `input.bind_key` defaults in a real config.cfg [OBSERVED; F5 and F4 are also OFFICIAL]:

| Key | Action |
|---|---|
| **F5** | Edit/Run toggle |
| **Pause** | pause |
| **F6** | reset scene |
| **F4** | Drivers window |
| `\` | console |
| `I` / `O` | toggle sensor/actuator tag views |
| `P` | palette |
| `B` | apply time scale |
| `V` | vertical move |

### 2.5 Programmatic scene control: what is possible

| Action | How |
|---|---|
| Load a scene | CLI `"load:<path>"`, or `auto.cfg` `scene.load_from_path(...)`. No Web API call exists, so restart Factory I/O to switch scenes, or drive the console/UI. |
| Run | CLI `run` / `scene.start_in_run_mode = True` / Web API rising edge on `FACTORY I/O (Run)` / F5 |
| Stop (back to Edit) | Web API `FACTORY I/O (Run)` = false / F5 [INFERRED from SDK + scripts] |
| Pause | Web API `FACTORY I/O (Pause)` / Pause key |
| Reset | Web API pulse on `FACTORY I/O (Reset)` (Output) / F6 |
| Driver connect | `drivers.modbustcp_server.auto_connect = True` (auto.cfg) plus the driver saved in the scene. Otherwise use the CONNECT button in the F4 window. |

---

## 3. Modbus drivers and the OpenPLC setup

Sources:

- https://docs.factoryio.com/manual/drivers/modbus-server/
- https://docs.factoryio.com/manual/drivers/modbus-client/
- https://docs.factoryio.com/manual/drivers/

### 3.1 Modbus TCP/IP Server (Factory I/O is the slave)

Requires the **Modbus & OPC Edition or the Ultimate Edition**. [OFFICIAL]

| Field | Meaning |
|---|---|
| Host | the server IP address (read-only) |
| Port | TCP port, **default 502** |
| Network adapter | which NIC to bind. On multi-NIC or VPN hosts, pick the one OpenPLC can reach. A 2.5.10 user's server bound to the Tailscale adapter and appeared dead [OBSERVED]. |
| Slave ID | default 1. **Since 2.5.6 the server always answers unit IDs 0 and 255 as well**, whatever the Slave ID field says. |
| Auto connect | auto-start the server (console: `drivers.modbustcp_server.auto_connect`) |
| Write Digital | where digital **sensor** values go: **Inputs** (discrete inputs, FC2; the default) or Coils |
| Read Digital | where digital **actuator** values come from: **Coils** (FC1/5/15; the default) or Inputs |
| Write Register | where analog/int **sensor** values go: **Input Registers** (FC4; the default) or Holding Registers |
| Read Register | where analog/int **actuator** values come from: **Holding Registers** (FC3/6/16; the default) or Input Registers |
| I/O Points | Digital Inputs offset+count (max 256), Digital Outputs offset+count (max 256), Register Inputs offset+count (max 64), Register Outputs offset+count (max 64) |
| Scale | Float sensor values are multiplied by Scale and Float actuator values are divided by it. Example from the docs: 3.14 with Scale 100 is sent as 314. Registers are 16-bit integers. |

Further detail:

- **Scene XML defaults.** The scene stores these as `<Properties ReadInputDiscretes="False" WriteCoils="False" ReadInputRegisters="False" WriteHoldingRegisters="False" ScaleFactor="100"/>`. Leave them all False, which gives the standard layout above. [SCENE-FILE; the mapping of the booleans to the UI fields is INFERRED]
- **Int tags** (counters, displays) are not scaled. [INFERRED from the docs wording]
- **Addresses are 0-based protocol addresses.** Factory I/O's tag export shows `Input 0`, `Coil 0`, `Input Reg 0` and `Holding Reg 0`. In Modicon 1-based notation these are 10001, 00001, 30001 and 40001.
- **Export the mapping** from the driver window. Example of the format [OBSERVED in real exports]:

  ```
  Name,Type,Data Type,Address
  High sensor,Input,Bool,Input 0
  Conveyor entry,Output,Bool,Coil 0
  Level meter,Input,Real,Input Reg 0
  Counter,Output,Int,Holding Reg 0
  ```

- **Mapping in the GUI.** In the F4 window, select a driver, click CONFIGURATION, drag tags onto I/O points (drag them back to unmap), then CONNECT. A green icon means connected. [OFFICIAL]
- **Default mappings ship in the scenes.** Built-in scenes carry default Modbus Server and Client mappings (section 4). One team on 2.5.10 found their copied scene's Server mapping empty while the Client mapping was filled. Check the window, and remap or copy if it is empty. [SCENE-FILE + OBSERVED]
- **Read-only scenes.** Built-in scenes are read-only. Save to **My Scenes** before changing the mapping, otherwise the driver changes are not saved. [OFFICIAL]
- **I/O update rate.** Not documented by Real Games. The official SDK sample uses an 8 ms cycle (`CycleTime = 8`). The effective loop is limited by OpenPLC polling (100 ms default) and the PLC scan time. [OFFICIAL SDK + UNVERIFIED]

### 3.2 Modbus TCP/IP Client (Factory I/O is the master)

| Field | Meaning |
|---|---|
| Host | the server IP (`127.0.0.1` for local) |
| Port | 502 |
| Slave ID | the remote unit ID (use 0 or 255 for CODESYS ≥ SP16) |
| Auto connect | auto-connect |
| Read Digital | read actuators from Inputs or Coils |
| Read Register | read actuators from Input or Holding Registers |
| Writes | "can only write to Coils and Holding Registers" |
| Data types | Int and Float are converted to 2-byte integers |

[OFFICIAL]

### 3.3 Recommended topology

Use **OpenPLC as master and Factory I/O Modbus TCP/IP Server as slave.** This is the setup OpenPLC's own UI expects for remote I/O, and the one widely used tutorials (Gardiner, samsclass OT101/OT121, Cantera) describe.

The reverse (Factory I/O Client with OpenPLC as slave) is awkward. The client may only *write* Coils and Holding Registers. On OpenPLC those are `%QX` (coils), `%QW` (HR 0–1023) and `%MW` (HR 1024–2047), so sensor bits would land in PLC *output* space. [OpenPLC_v3 `modbus.cpp` + OFFICIAL client doc; conclusion INFERRED]

### 3.4 OpenPLC Runtime v3: exact UI and semantics

Verified against https://github.com/thiagoralves/OpenPLC_v3 (`webserver/webserver.py`, `webserver/pages.py`, `webserver/core/modbus_master.cpp`).

- **Slave Devices page banner** (verbatim): *"Attention: Slave devices are attached to address 100 onward (i.e. %IX100.0, %IW100, %QX100.0, and %QW100)"*.
- **"Add new device" form:**
  - Device Name.
  - Device Type: `Generic Modbus TCP Device` (other options: Arduino Uno/Mega, ESP32, ESP8266, Generic Modbus RTU Device).
  - Slave ID, IP Address, IP Port.
  - `Discrete Inputs (%IX100.0)`: Start Address, Size.
  - `Coils (%QX100.0)`: Start Address, Size.
  - `Input Registers (%IW100)`: Start Address, Size.
  - `Holding Registers - Read (%IW100)`: Start Address, Size.
  - `Holding Registers - Write (%QW100)`: Start Address, Size.
- **Settings page:** `Polling Period (ms)` and `Timeout (ms)`. The source defaults are `polling_period = 100` and `timeout = 1000`.
- **Function codes** (from the source):
  - DI are read with FC2, `modbus_read_input_bits`.
  - Coils are written with FC15, `modbus_write_bits`, every poll.
  - IR are read with FC4.
  - HR-read uses FC3.
  - HR-write uses FC16, every poll.
- **Placement in PLC memory:**
  - Bit *i* of the concatenated DI buffer becomes `%IX(100 + i/8).(i%8)`. Coils map the same way to `%QX`.
  - Register *i* of the concatenated IR buffer, *followed by* the HR-read buffer, becomes `%IW(100+i)`. HR-write *i* becomes `%QW(100+i)`.
  - With several devices, their blocks are appended in order. Max 400 points per class.
  - Start Address is the 0-based Modbus address, passed straight to libmodbus.
- **`mbconfig.cfg` keys** generated by the webserver: `Num_Devices`, `Polling_Period`, `Timeout`, `device0.name`, `.slave_id`, `.protocol` (TCP), `.address`, `.IP_Port`, `.Discrete_Inputs_Start/Size`, `.Coils_Start/Size`, `.Input_Registers_Start/Size`, `.Holding_Registers_Read_Start/Size`, `.Holding_Registers_Start/Size`.
- **Port clash.** OpenPLC's own Modbus *server* also listens on 502. If OpenPLC and Factory I/O share a host, move Factory I/O to another port (tutorials use 503) or disable OpenPLC's Modbus server. Start the Factory I/O server before "Start PLC". [community tutorials / OpenPLC forum]
- **OpenPLC v4** (Autonomy-Logic/openplc-runtime) instead configures Modbus master points one by one (`fc`, `offset`, `iec_location`, `len`, `cycle_time_ms`) through the new editor. You choose the IEC location, so `%IX100.0` is a convention rather than a rule there. Everything above is v3. [source: `modbus_master_config_model.py`]

Step list (v3):

1. In Factory I/O, open the scene, then **File > Save As** into My Scenes.
2. Press **F4**, choose **Modbus TCP/IP Server**, then **CONFIGURATION**:
   - Network adapter: the NIC reachable from OpenPLC.
   - Port 502 (or 503 on a shared host).
   - Slave ID 1.
   - Auto connect on.
   - Leave Write Digital = Inputs, Read Digital = Coils, Write Register = Input Registers, Read Register = Holding Registers.
   - Scale 100.
   - Keep or verify the scene's default mapping and **Export tags**.
   - CONNECT, then F5 to Run.
3. In the OpenPLC web UI (port 8080), go to **Slave Devices > Add new device**:
   - Device Type `Generic Modbus TCP Device`, Slave ID 1, the IP of the Factory I/O host, port 502.
   - Start Address 0 in every block, with sizes from the tables below.
   - Save.
   - Under Settings, set Polling Period to 100 ms (or 50), and Timeout to 1000.
4. In the PLC program, declare located variables at the addresses below. Upload, then **Start PLC**.

### 3.5 Recommended mapping: Sorting by Height (Basic)

This is the scene's **default Modbus TCP/IP Server layout**. It is identical in independent copies saved by 2.5.4 and 2.5.7, and identical to the default Client layout [SCENE-FILE].

OpenPLC device: DI start 0 size 14, Coils start 0 size 10, IR size 0, HR-read size 0, HR-write start 0 size 1.

| Modbus (0-based) | Factory I/O tag | Kind/Type | OpenPLC |
|---|---|---|---|
| DI 0 | High sensor | Input Bit | %IX100.0 |
| DI 1 | Low sensor | Input Bit | %IX100.1 |
| DI 2 | Pallet sensor | Input Bit | %IX100.2 |
| DI 3 | Loaded | Input Bit | %IX100.3 |
| DI 4 | At left entry | Input Bit (NC-like) | %IX100.4 |
| DI 5 | At left exit | Input Bit (NC-like) | %IX100.5 |
| DI 6 | At right entry | Input Bit (NC-like) | %IX100.6 |
| DI 7 | At right exit | Input Bit (NC-like) | %IX100.7 |
| DI 8 | Start | Input Bit (NO) | %IX101.0 |
| DI 9 | Reset | Input Bit (NO) | %IX101.1 |
| DI 10 | Stop | Input Bit (**NC**) | %IX101.2 |
| DI 11 | Emergency stop | Input Bit (**NC**) | %IX101.3 |
| DI 12 | Auto | Input Bit | %IX101.4 |
| DI 13 | FACTORY I/O (Running) | Input Bit | %IX101.5 |
| (not mapped) | Manual | Input Bit | add as DI 14 = %IX101.6 if needed |
| Coil 0 | Conveyor entry | Output Bit | %QX100.0 |
| Coil 1 | Load | Output Bit | %QX100.1 |
| Coil 2 | Unload | Output Bit | %QX100.2 |
| Coil 3 | Transf. left | Output Bit | %QX100.3 |
| Coil 4 | Transf. right | Output Bit | %QX100.4 |
| Coil 5 | Conveyor left | Output Bit | %QX100.5 |
| Coil 6 | Conveyor right | Output Bit | %QX100.6 |
| Coil 7 | Start light | Output Bit | %QX100.7 |
| Coil 8 | Reset light | Output Bit | %QX101.0 |
| Coil 9 | Stop light | Output Bit | %QX101.1 |
| HR 0 | Counter | Output Int | %QW100 |

### 3.6 Recommended mapping: Level Control

This is the default Modbus TCP/IP Server layout. It is consistent between copies saved by 2.2.3 and 2.5.4; one of them has renamed tags but the same GUIDs [SCENE-FILE].

OpenPLC device: DI 0/4, Coils 0/3, IR 0/3, HR-read 0/0, HR-write 0/4.

| Modbus | Factory I/O tag | Kind/Type | OpenPLC | Scaling (Scale = 100) |
|---|---|---|---|---|
| DI 0 | Start | Input Bit (NO) | %IX100.0 | |
| DI 1 | Reset | Input Bit (NO) | %IX100.1 | |
| DI 2 | Stop | Input Bit (NC) | %IX100.2 | |
| DI 3 | FACTORY I/O (Running) | Input Bit | %IX100.3 | |
| Coil 0 | Start light | Output Bit | %QX100.0 | |
| Coil 1 | Reset light | Output Bit | %QX100.1 | |
| Coil 2 | Stop light | Output Bit | %QX100.2 | |
| IR 0 | Level meter | Input Float | %IW100 | 0–10.0 is sent as 0–1000 |
| IR 1 | Flow meter | Input Float | %IW101 | ×100 |
| IR 2 | Setpoint (panel potentiometer) | Input Float | %IW102 | ×100 |
| HR 0 | Fill valve | Output Float | %QW100 | write 0–1000 for 0–10.0 |
| HR 1 | Discharge valve | Output Float | %QW101 | ÷100. **Pre-forced in the scene files seen** (values differ by copy); check `isForced` at startup. |
| HR 2 | SP (display) | Output Int | %QW102 | raw |
| HR 3 | PV (display) | Output Int | %QW103 | raw |

### 3.7 Defaults seen for other scenes

All [SCENE-FILE] or [OBSERVED: Factory I/O tag exports in nesfit/bonnet-ics-library].

**From A to B**

- DI 0 Sensor, DI 1 FACTORY I/O (Running)
- Coil 0 Conveyor

**Filling Tank (Timers)**, 2.5.10

- DI 0 Fill, DI 1 Discharge, DI 2 FACTORY I/O (Running)
- Coil 0 Fill valve, Coil 1 Filling, Coil 2 Discharge valve, Coil 3 Discharging
- `Timer` (Output Int) is not mapped by default; add it as HR 0.

**Separating Station** (export)

- DI 0 Sensor 1, DI 1 Pusher 1 front, DI 2 Pusher 1 back, DI 3 At pusher 1 exit, DI 4 Sensor 2, DI 5 Pusher 2 front, DI 6 Pusher 2 back, DI 7 At pusher 2 exit, DI 8 Start, DI 9 Reset, DI 10 Stop, DI 11 Emergency stop, DI 12 FACTORY I/O (Running)
- Coil 0 Entry conveyor 1, Coil 1 Pusher 1, Coil 2 Conveyor 1, Coil 3 Entry conveyor 2, Coil 4 Pusher 2, Coil 5 Conveyor 2, Coil 6 Start light, Coil 7 Reset light, Coil 8 Stop light
- IR 0 Vision sensor 1, IR 1 Vision sensor 2
- HR 0 Counter 1, HR 1 Counter 2

**Sorting Station** (export)

- DI 0 At exit, DI 1 Start, DI 2 Reset, DI 3 Stop, DI 4 Emergency stop, DI 5 Auto, DI 6 FACTORY I/O (Running)
- Coil 0 Entry conveyor, Coil 1 Stop blade, Coil 2 Exit conveyor, Coil 3 Sorter 1 turn, Coil 4 Sorter 1 belt, Coil 5 Sorter 2 turn, Coil 6 Sorter 2 belt, Coil 7 Sorter 3 turn, Coil 8 Sorter 3 belt, Coil 9 Start light, Coil 10 Reset light, Coil 11 Stop light
- IR 0 Vision sensor
- HR 0–2 Counter 1–3

**Assembler** (export)

- DI 0 Moving X, DI 1 Moving Z, DI 2 Item detected, DI 3 Lid at place, DI 4 Lid clamped, DI 5 Pos. at limit (lids), DI 6 Base at place, DI 7 Base clamped, DI 8 Pos. at limit (bases), DI 9 Part leaving, DI 10 Start, DI 11 Reset, DI 12 Stop, DI 13 Emergency stop, DI 14 Auto, DI 15 FACTORY I/O (Running)
- Coil 0 Move X, Coil 1 Move Z, Coil 2 Grab, Coil 3 Lids conveyor, Coil 4 Clamp lid, Coil 5 Pos. raise (lids), Coil 6 Bases conveyor, Coil 7 Clamp base, Coil 8 Pos. raise (bases), Coil 9 Start light, Coil 10 Reset light, Coil 11 Stop light
- HR 0 Counter

**Production Line** (export)

- DI 0 Lids at entry, DI 1 Lids center (busy), DI 2 Lids center (has error), DI 3 Lids at exit, DI 4 Bases at entry, DI 5 Bases center (busy), DI 6 Bases center (has error), DI 7 Bases at exit, DI 8 FACTORY I/O (Running)
- Coil 0 Lids raw conveyor, Coil 1 Lids center (produce lids), Coil 2 Lids center (start), Coil 3 Lids center (reset), Coil 4 Lids center (stop), Coil 5 Lids exit conveyor 1, Coil 6 Lids exit conveyor 2, Coil 7 Bases raw conveyor, Coil 8 Bases center (produce lids), Coil 9 Bases center (start), Coil 10 Bases center (reset), Coil 11 Bases center (stop), Coil 12 Bases exit conveyor 1, Coil 13 Bases exit conveyor 2, Coil 14 Exit conveyor
- HR 0 Lids counter, HR 1 Bases counter

---

## 4. Scenes

Scenes index: https://docs.factoryio.com/manual/scenes/ [OFFICIAL]. Factory I/O comes with **21 scenes**. They are read-only; save a copy to My Scenes to customize one.

### 4.1 Built-in scenes and operator panels

**Panel** here means Start/Stop/Reset push buttons with lights, an Emergency stop and an Auto/Manual selector. The panel column comes from the tag lists in 4.2–4.4. The objectives are the official scene descriptions (docs, or the `<Description>` stored in the scene file).

| # | Exact scene name | Objective | Operator panel |
|---|---|---|---|
| 1 | From A to B | Transport a box until it reaches a sensor. | **No** |
| 2 | From A to B (Set and Reset) | Transport a box from sensor A to sensor B. | **No** |
| 3 | Filling Tank (Timers) | Fill and empty a tank using timers. | Partial: Fill and Discharge buttons, Filling and Discharging lights, Timer display. No Start/Stop/E-stop. |
| 4 | Queue of Items (Counters) | Load and unload three boxes onto a conveyor. | **No** |
| 5 | Assembler | Assemble parts made of lids and bases using a two-axis pick and place. | Yes (full) |
| 6 | Assembler (Analog) | …two-axis pick and place with analog values. | Yes (full) |
| 7 | Automated Warehouse | (not retrieved) | not verified |
| 8 | Buffer Station | Buffer and separate up to five boxes. | Yes (full) |
| 9 | Converge Station | Converge two paths into a single one. | Yes (full) |
| 10 | Elevator (Advanced) | (not retrieved) | Yes (full, plus floor lights) |
| 11 | Elevator (Basic) | (not retrieved) | Yes (full) |
| 12 | Level Control | Control the liquid level (or flow) of a tank using a PID controller. | Partial: Start/Stop/Reset with lights, Setpoint potentiometer, SP/PV displays. No E-stop or Auto/Manual. |
| 13 | Palletizer | Palletize cases in several layers. | Yes (full) |
| 14 | Pick & Place (Basic) | Pick and place items from one conveyor into another. | Yes (full) |
| 15 | Pick & Place XYZ | (not retrieved) | Yes (full) |
| 16 | Production Line | Produce the same number of lids and bases by controlling two machining centers. | **No** operator panel. The machining-center start/stop/reset are PLC *outputs*. |
| 17 | Separating Station | Separate blue and green parts into two conveyors. | Yes: Start/Reset/Stop/E-stop with lights (Auto/Manual not in the default map) |
| 18 | Sorting by Height (Advanced) | Sort cardboard boxes by height using a turntable (compatible with ITS PLC). | Yes (full, plus a Red/Yellow/Green stack light) |
| 19 | Sorting by Height (Basic) | Sort cardboard boxes by height using a chain transfer. | Yes (full) |
| 20 | Sorting by Weight | Sort cardboard boxes by weight using a conveyor scale. | Yes (full) |
| 21 | Sorting Station | Separate green and blue items using a vision sensor. | Yes (full) |

Confirmed scene doc URLs, all under `https://docs.factoryio.com/manual/scenes/`: `from-a-to-b/`, `from-a-to-b-sr/`, `filling-tank/`, `queue-of-items/`, `assembler/`, `automated-warehouse/`, `buffer-station/`, `converge-station/`, `elevator-basic/`, `level-control/`, `pick-and-place-basic/`, `production-line/`, `separating-station/`, `sorting-by-weight/`, `sorting-station/`.

These official pages show objectives and images. Search extracts did not show any tag tables on them, so the tag names below come from the app itself.

**Sources for tag names, in order of authority:**

1. The official Real Games SDK sample controllers: `realgamessoftware/factoryio-sdk/samples/Controllers/Scenes/*.cs`, one per built-in scene. They give the name, kind and type of every tag the sample uses.
2. Scene XML files saved by Factory I/O.
3. Runtime captures of every tag in 18 built-in scenes (lordmoses/SCAPHY).

Names below are **exact, including case and punctuation**: `Transf. left`, `Pos. at limit (lids)`, `Buffer Vel.`.

### 4.2 Demo scene A (recommended): Sorting by Height (Basic)

Why it is the primary demo:

- It has a full operator panel and pure digital I/O (14 DI, 10 coils, 1 HR).
- The official SDK ships a reference controller.
- The default Modbus map is known (section 3.5).
- It offers rich faults: mis-sort (force a height sensor), jam (force an exit eye), stuck transfer (force an actuator).

Full tag list. All entries are [SCENE-FILE], and the GUIDs are identical across copies saved by 2.5.4, 2.5.7 and 2.5.10. The idle values are [OBSERVED].

| Tag name | Sensor/actuator | Kind | Type | Addr | Idle value / notes | GUID |
|---|---|---|---|---|---|---|
| High sensor | sensor (diffuse, height) | Input | Bit | 5 | false; true when a tall box passes | 52052c12-f2ba-4289-a574-9ba7bd5ac0a2 |
| Low sensor | sensor (diffuse, height) | Input | Bit | 6 | false; true for any box | 8e91c4f8-08ff-42dd-9f86-7e06c77cbf57 |
| Pallet sensor | sensor | Input | Bit | 7 | false; true when a box waits at the transfer | 09dc60bb-47e4-4783-9a9b-32f1dd1a60fd |
| At left entry | sensor (retroreflective) | Input | Bit | 8 | **true when clear** | 1efa965c-b01e-40e0-9053-d1efc50a4c31 |
| Start | panel push button (NO) | Input | Bit | 9 | false | ec38f1b3-ee81-431d-81b5-b9e9ea50371a |
| At right exit | sensor (retroreflective) | Input | Bit | 10 | true when clear | de72ef2c-93e1-4abb-8cc0-ff01b11e8f14 |
| At left exit | sensor (retroreflective) | Input | Bit | 11 | true when clear | cc8294d8-31e2-4fc7-860b-9ee83a9708fb |
| At right entry | sensor (retroreflective) | Input | Bit | 12 | true when clear | 13ba32d0-9879-4a9a-a966-23b978a96a54 |
| Stop | panel push button (**NC**) | Input | Bit | 13 | **true** | df43b72e-992a-4936-9d46-32764400b933 |
| Reset | panel push button (NO) | Input | Bit | 14 | false | bf9730af-8058-4857-aca1-752fa3e4dabe |
| Emergency stop | panel mushroom button (**NC**, latching) | Input | Bit | 15 | **true** | a6076c84-fca7-4b87-9f64-c02339be30da |
| Loaded | sensor (box on chain transfer) | Input | Bit | 16 | false | 8c905137-00c0-418a-aaff-f4371ea800e4 |
| Manual | panel selector position | Input | Bit | 17 | **true** (selector rests on Manual) | df76cd5c-c905-4c86-b0ec-32cb232d7cf3 |
| Auto | panel selector position | Input | Bit | 18 | false | c413366b-dc8f-4ab8-884b-44c34fadee9a |
| Load | actuator (transfer rollers load) | Output | Bit | 0 | | c1ddcc93-39f7-4e2d-af3b-f5dfe4e2bb8c |
| Unload | actuator | Output | Bit | 1 | | 32025197-e0ff-4560-a58b-770f0e41ab6d |
| Transf. left | actuator (chain transfer to left) | Output | Bit | 2 | | 2278a6d8-5176-4fac-b44a-70662cd606a3 |
| Transf. right | actuator (chain transfer to right) | Output | Bit | 3 | | 040505a7-56ca-467c-806b-52fee05e942e |
| Conveyor entry | actuator | Output | Bit | 4 | | b1629365-01ad-4df4-bc84-0afa188f1a20 |
| Conveyor left | actuator | Output | Bit | 5 | | 3627aa26-16a9-4d32-8d80-ac8b3b078fe5 |
| Conveyor right | actuator | Output | Bit | 6 | | 4c936da3-ed49-41fc-a34a-9e595f5d01f6 |
| Emitter | actuator (box source) | Output | Bit | 7 | **pre-forced true** | bbd01a8f-918e-467c-bfc0-e184206b207e |
| Remover left | actuator (box sink) | Output | Bit | 8 | **pre-forced true** | 3f301755-9dfc-4ab5-9bd6-29d99163e9d0 |
| Remover right | actuator (box sink) | Output | Bit | 9 | **pre-forced true** | 77860c1a-54e0-4982-9489-66298d1a1cf6 |
| Start light | panel light | Output | Bit | 10 | | a6edfd36-d3cd-4b32-b565-63cc6149478f |
| Stop light | panel light | Output | Bit | 11 | | d6749eab-0ea8-42c5-adde-2ddbaad46430 |
| Reset light | panel light | Output | Bit | 12 | | 75512fd4-1144-4fac-94d4-767fe820508c |
| Counter | panel digital display | Output | Int | 0 | | 45a714bf-77bb-47e7-b046-43e29c59b9e0 |

System tags for this scene:

| Tag | Kind/Type | GUID |
|---|---|---|
| FACTORY I/O (Running) | Input Bit | 5fc5ac24-3714-448f-b6ac-6f4b6731d3a0 |
| FACTORY I/O (Paused) | Input Bit | 82c1abd5-7873-4145-b82d-fb72b314ce6e |
| FACTORY I/O (Reset) | Input Bit | d63bac73-82ff-49d5-9f24-a611e76f0f04 |
| FACTORY I/O (Time Scale) | Input Float | 4a426dda-b297-47cd-962a-3beed9e93e22 |
| FACTORY I/O (Run) | Output Bit | 7754fab1-… |
| FACTORY I/O (Pause) | Output Bit | 41b90af6-… |
| FACTORY I/O (Reset) | Output Bit | 01936c60-… |
| FACTORY I/O (Camera Position) | Output Int | f0855715-… |

Five unnamed Input bits (`-`, addresses 0–4) also exist; ignore them.

Reference logic: the official SDK `SortingHeightBasic.cs`.

- A rising edge on `Pallet sensor` (when the transfer is free) sets `Load`.
- A rising `Low sensor` sets "send left". A rising `High sensor` sets "send right", so tall boxes go right.
- A rising `Loaded` clears Load and drives `Transf. left` plus `Conveyor left`, or the right-hand pair.
- A rising `At left entry` or `At right entry` (the box has cleared the eye) ends the transfer and increments `Counter`.
- `Conveyor entry = !Pallet sensor || Load`.

Demo faults:

| Fault | How |
|---|---|
| Mis-sort | force `High sensor = true` (every box looks tall) or `false` |
| Jam / blocked eye | force `At left entry = false` |
| Dead sensor | Always Off failure on `Loaded` |
| Motor failure | force `Conveyor entry = false` |
| E-stop | force `Emergency stop = false` |
| Stop box flow | force `Emitter = false` |

### 4.3 Demo scene B (recommended): Level Control

This scene provides an analog/PID showcase with continuous time-series measurements.

| Tag name | Sensor/actuator | Kind | Type | Addr | Notes | GUID |
|---|---|---|---|---|---|---|
| Start | panel push button (NO) | Input | Bit | 0 | | 5ab5ea29-5b40-4d35-be90-9a76bbf61111 |
| Stop | panel push button (NC) | Input | Bit | 1 | idle true | e07eeb25-6ce5-4946-a73b-d9db6bdadfd7 |
| Reset | panel push button (NO) | Input | Bit | 2 | | 2345d514-f977-4952-90e5-187c98a42b91 |
| Level meter | sensor (analog) | Input | Float | 0 | 0–10 V; up to about 4.2 in captures | d56c40cf-4e46-4abf-a914-6e98b599d2b5 |
| Flow meter | sensor (analog) | Input | Float | 1 | 0–10 | ee225f5b-fe34-4a61-839c-732071ba8490 |
| Setpoint | panel potentiometer | Input | Float | 2 | 0–10. Forcing it acts as a "virtual knob". | 29b3fedf-6a79-4cab-ae62-90a5eef0799a |
| Start light | panel light | Output | Bit | 0 | | bd7e9ec7-5fef-428d-b2d0-f8f1d7fade50 |
| Stop light | panel light | Output | Bit | 1 | | ffd86a04-cfcf-47a8-bc2a-c24cf017b8f5 |
| Reset light | panel light | Output | Bit | 2 | | e8315a8e-b8b3-4805-b3d8-2c21f31a3b22 |
| Fill valve | actuator (analog valve) | Output | Float | 0 | 0–10 | 24dfcc79-42c7-4752-bd69-3ede95238888 |
| Discharge valve | actuator (analog valve) | Output | Float | 1 | pre-forced in the scene files seen | 75425221-eebb-4095-8867-2006cb107709 |
| SP | panel digital display | Output | Int | 0 | units chosen by the PLC | 754aeb6c-07ce-4014-9ff5-13e37b9d2c3a |
| PV | panel digital display | Output | Int | 1 | | 004eb08b-6a4c-4f3e-b750-9865f4fd6950 |

- Types and kinds match the official SDK `LevelControl.cs` (Level meter and Setpoint Input Float; Fill valve Output Float; PV and SP Output Int).
- GUIDs: [SCENE-FILE], identical in 2.2.3 and 2.5.4 copies.
- Value ranges: [OBSERVED].

Demo faults:

| Fault | How |
|---|---|
| Stuck level transmitter | force `Level meter = 2.0` and watch the tank overflow or drain |
| Saturated sensor | Always On failure on `Level meter` |
| Valve failure | force `Fill valve = 0` |
| Operator error | force `Setpoint` |

**Fallback simple scene: Filling Tank (Timers)**, 2.5.10, [SCENE-FILE].

| Kind/Type | Tags |
|---|---|
| Input Bit | `Fill` (button), `Discharge` (button) |
| Output Bit | `Fill valve`, `Discharge valve`, `Filling` (light), `Discharging` (light) |
| Output Int | `Timer` (display) |

There are no process sensors, so fault injection is limited.

### 4.4 Other candidate scenes: full tag lists

Kind and type come from the SDK, the scene files and the capture ordering (input bits, then input floats, then input ints, then output bits, then output floats, then output ints; checked against the SDK). Emitter/Remover tags are normally pre-forced TRUE, as in the scene files seen.

**From A to B** [SCENE-FILE 2.5.8 + SDK]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Sensor`. Retroreflective: TRUE while clear, FALSE when the box arrives. The SDK logic is `Conveyor = Sensor`. |
| Output Bit | `Conveyor` |

No panel.

**From A to B (Set and Reset)** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Sensor A`, `Sensor B` |
| Output Bit | `Conveyor`, `Entry conveyor` |

No panel.

**Queue of Items (Counters)** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At entry`, `At exit`, `Item ready` |
| Output Bit | `Entry conveyor`, `Buffer conveyor`, `Emitter`, `Remover` |

No panel.

**Sorting by Weight** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At scale`, `At scale entry`, `At scale exit`, `At exit left`, `At exit right`, `At exit front`, `At left entry`, `At right entry`, `At forward entry`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Input Float | `Weight` (scale) |
| Output Bit | `Load scale`, `Entry conveyor`, `Send forward`, `Send left`, `Send right`, `Left conveyor`, `Right conveyor`, `Front conveyor`, `Emitter`, `Remover` (×3, same name), `Start light`, `Stop light`, `Reset light` |
| Output Int | `Weight` (display, same name as the sensor), `Forward count`, `Right count`, `Left count` |

**Buffer Station** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At buffer entry`, `At buffer exit`, `At exit`, `Start`, `Reset`, `Stop`, `Emergency stop`, `Manual`, `Auto` |
| Input Float | `Buffer Vel.` |
| Output Bit | `Stop blade`, `Emitter`, `Remover`, `Start light`, `Reset light`, `Stop light` |
| Output Float | `Buffer conveyor`, `Exit conveyor` (analog conveyors) |
| Output Int | `Counter` |

**Converge Station** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At entry 1`, `At entry 2`, `At transfer 1`, `At transfer 2`, `At exit`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Output Bit | `Conveyor 1`, `Conveyor 2`, `Exit conveyor`, `Load 1`, `Unload 1`, `Transfer left 1`, `Transfer right 1`, `Load 2`, `Unload 2`, `Transfer left 2`, `Transfer right 2`, `Emitter 1`, `Emitter 2`, `Remover`, `Start light`, `Stop light`, `Reset light` |
| Output Int | `Counter` |

**Separating Station** [SDK + export]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Sensor 1`, `Sensor 2`, `Pusher 1 front`, `Pusher 1 back`, `Pusher 2 front`, `Pusher 2 back`, `At pusher 1 exit`, `At pusher 2 exit`, `Start`, `Reset`, `Stop`, `Emergency stop` |
| Input Int | `Vision sensor 1`, `Vision sensor 2` |
| Output Bit | `Entry conveyor 1`, `Entry conveyor 2`, `Conveyor 1`, `Conveyor 2`, `Pusher 1`, `Pusher 2`, `Start light`, `Reset light`, `Stop light`, `Emitter 1`, `Emitter 2`, `Remover 1`, `Remover 2` (the last four pre-forced; [SCENE-FILE]) |
| Output Int | `Counter 1`, `Counter 2` |

No Auto/Manual selector appears in either source.

**Sorting by Height (Advanced)** [SDK + third-party I/O list]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At entry`, `At back`, `At front`, `At turntable entry`, `At load position`, `At unload position`, `At left entry`, `At left exit`, `At right entry`, `At right exit`, `High box`, `Low box`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Auto`, `Manual` |
| Output Bit | `Feeder conveyor`, `Entry conveyor`, `Load`, `Unload`, `Turn`, `Left conveyor`, `Right conveyor`, `Start light`, `Stop light`, `Reset light`, plus stack-light and emitter/remover tags |
| Output Int | `Counter` |

The panel part is partly [UNVERIFIED].

**Production Line** [export + capture + SDK]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Lids at entry`, `Lids at exit`, `Bases at entry`, `Bases at exit`, `Lids center (busy)`, `Lids center (has error)`, `Bases center (busy)`, `Bases center (has error)`, `Machining Center 1 (Opened)`, `Machining Center 2 (Opened)` |
| Input Int | `Machining Center 1 (Progress)`, `Machining Center 2 (Progress)` |
| Output Bit | `Lids raw conveyor`, `Bases raw conveyor`, `Lids center (produce lids)`, `Lids center (start)`, `Lids center (stop)`, `Lids center (reset)`, `Bases center (produce lids)` (sic), `Bases center (start)`, `Bases center (stop)`, `Bases center (reset)`, `Lids exit conveyor 1`, `Lids exit conveyor 2`, `Bases exit conveyor 1`, `Bases exit conveyor 2`, `Exit conveyor`, `Lids emitter`, `Bases emitter`, `Remover` |
| Output Int | `Lids counter`, `Bases counter` |

The SDK sample also references `Lids center (running)` and `Bases center (running)`. These are absent in the 2.5 captures, so they were probably renamed [UNVERIFIED].

**Pick & Place (Basic)** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Item at entry`, `Item at exit`, `Item detected`, `Moving X`, `Moving Z`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Output Bit | `Entry conveyor`, `Exit conveyor`, `Move X`, `Move Z`, `Grab`, `Emitter`, `Remover`, `Start light`, `Stop light`, `Reset light` |
| Output Int | `Counter` |

**Pick & Place XYZ** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Detected`, `C limit`, `Box at place`, `Part at place`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Input Float | `X`, `Y`, `Z` |
| Output Bit | `C +`, `Grab`, `Box conveyor`, `Part conveyor`, `Exit conveyor`, `Box emitter`, `Part emitter`, `Box remover`, `Exit green`, `Exit red`, `Exit yellow`, `Start light`, `Stop light`, `Reset light` |
| Output Float | `SP X`, `SP Y`, `SP Z` |
| Output Int | `Counter` |

**Assembler** [SDK + export + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Moving X`, `Moving Z`, `Item detected`, `Lid at place`, `Lid clamped`, `Pos. at limit (lids)`, `Base at place`, `Base clamped`, `Pos. at limit (bases)`, `Part leaving`, `Start`, `Reset`, `Stop`, `Emergency stop`, `Auto`, `Manual` |
| Output Bit | `Move X`, `Move Z`, `Grab`, `Lids conveyor`, `Clamp lid`, `Pos. raise (lids)`, `Bases conveyor`, `Clamp base`, `Pos. raise (bases)`, `Lids emitter`, `Bases emitter`, `Remover 1`, `Remover 2`, `Start light`, `Reset light`, `Stop light` |
| Output Int | `Counter` |

**Palletizer** [SDK + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `Box at entry`, `Pallet at entry`, `Pallet at exit`, `Pallet loaded`, `Pusher limit`, `Plate limit`, `Elevator moving`, `Clamped`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Output Bit | `Box feeder`, `Load belt`, `Turn`, `Push`, `Clamp`, `Open plate`, `Elevator up`, `Elevator down`, `Move to limit`, `Load pallet`, `Pallet feeder`, `Exit conveyor`, `Warning light`, `Parts emitter`, `Pallets emitter`, `Remover`, `Start light`, `Stop light`, `Reset light` |
| Output Int | `Counter` |

**Sorting Station** [SDK + export + capture]

| Kind/Type | Tags |
|---|---|
| Input Bit | `At exit`, `Start`, `Stop`, `Reset`, `Emergency stop`, `Manual`, `Auto` |
| Input Int | `Vision sensor` |
| Output Bit | `Entry conveyor`, `Exit conveyor`, `Stop blade`, `Sorter 1 turn`, `Sorter 1 belt`, `Sorter 2 turn`, `Sorter 2 belt`, `Sorter 3 turn`, `Sorter 3 belt`, `Emitter`, `Remover 1`, `Remover 2`, `Remover 3`, `Start light`, `Stop light`, `Reset light` |
| Output Int | `Counter 1`, `Counter 2`, `Counter 3` |

The Elevator (Basic/Advanced) and Automated Warehouse lists are in the SDK samples and the SCAPHY captures; they were not needed here.

### 4.5 Adding a control panel to a scene (editor)

[OFFICIAL: parts/operators, getting-started/creating-a-scene, edit-and-run]

1. Open the scene. If it is built in, **save it to My Scenes** first.
2. Press **F5** to switch to **Edit** mode. Parts can only be added in Edit mode.
3. Open the **Palette** (toolbar icon, or `P`) and choose the **Operators** category:
   - Emergency Stop.
   - Push Buttons: Start, Reset, Stop (NC), plus generic Push Button NO/NC since 2.5.6.
   - Light Indicators.
   - Selector.
   - Potentiometer.
   - Digital Display.
   - **Electric Switchboard** (the panel box).
   - Column.
   - Stack Light, Warning Light and Alarm Siren are in the **Warning Devices** category.
4. Drag the Electric Switchboard into the 3D view, then drag the buttons, lights and display onto it.
   - Use `V` plus drag for vertical moves.
   - Double-click to set the point of interest, which sets the placement height.
5. Rename the new tags. Default names follow the part, for example "Emergency Stop #". Docked tags can be renamed, forced and failure-injected.
6. Press **F4**, map the new tags onto free Modbus I/O points (for example DI 14+ and Coil 10+), and widen the OpenPLC device sizes to match.
7. Save the scene.

---

## 5. Forcing and fault simulation

| Topic | Fact | Status |
|---|---|---|
| Forcing in the UI | "Sensors and actuators tags can be forced by Left-clicking on the tag's button, slider or input field." | OFFICIAL |
| Release in the UI | "To release a forced value, mouse-hover the FORCED button and Left-click on RELEASE." A forced value **persists until released**, and is even saved in the scene file. | OFFICIAL + SCENE-FILE |
| Sensor forcing | "Forcing sensor's tags overrides the sensor's values. Even if a sensor is not detecting an item, forcing its value will make it to be sent to the controller." | OFFICIAL |
| Actuator forcing | "Forcing an actuator's tag will override the value read from the controller." | OFFICIAL |
| Visual indication | The docked tag shows **FORCED**. Since 2.5.0 the driver window shows a warning icon next to forced tags; since 2.5.1 it also shows failure icons. | OFFICIAL |
| Web API forcing | Since 2.5.2: `PUT /api/tag/values-force[/by-name]` and `PUT /api/tag/values-release[/by-name]`. State is visible in `isForced`/`forcedValue`. | OFFICIAL |
| Failure injection (built in) | Failure types are "no failure", **Always On** and **Always Off**. "A failure will override the signal between the part and the controller." For Float/Int tags, Always On saturates the value. UI: select a docked tag, left-click the no-failure icon for an On failure, right-click for an Off failure. Added in 2.1.3. | OFFICIAL |
| Web API failures | `PUT /api/tag/values-alwayson[/by-name]` and `…/values-alwaysoff[/by-name]` with `{value:true}`. State is visible in `shortCircuit` (always on) and `openCircuit` (always off). Clearing with `value:false` is [INFERRED]. | OFFICIAL |
| Hiding failures | The Instructor option "Hide Failures" hides all failure warnings. This is useful for diagnose-the-fault demos. | OFFICIAL |
| Force vs failure | A **force** sets a specific value. A **failure** emulates wiring faults: open circuit is stuck low, short circuit is stuck high or saturated. Both reach the PLC. | OFFICIAL + INFERRED |
| Cleanup | Release only the IDs you forced. Never release `Emitter`/`Remover*` (pre-forced). Check `/api/tags` for `isForced \|\| openCircuit \|\| shortCircuit` before each test. | INFERRED |

---

## 6. Practical constraints

| Topic | Facts |
|---|---|
| OS | **Windows only**. Requirements list Windows 7 SP1+, an SSE2 CPU, and **DirectX 10/11/12** graphics (NVIDIA since GeForce 8, AMD since Radeon HD 2000, Intel since HD 4000). No Linux or macOS builds; Wine is untested. [OFFICIAL] RAM is not specified. Windows Server support is [UNVERIFIED]. |
| GPU | A dedicated GPU noticeably improves frame rate [community]. A VMware VM crashed without 3D acceleration [community]. For a cloud VM, use a **GPU instance** such as AWS g4dn/g5/g6 with NVIDIA drivers and **Amazon DCV**, which costs nothing extra on EC2. Lower `video.quality` and `video.target_fps` in `auto.cfg`. [INFERRED + AWS docs] |
| Remote desktop | If the camera doesn't rotate or move over RDP/VM/DCV, set `input.force_alternative_mouse_data = True`. [OFFICIAL help article 32] Factory I/O keeps simulating when it loses focus (since 2.4.0). Prefer DCV, which uses the console session, over RDP so the app keeps rendering after you disconnect [UNVERIFIED for Factory I/O]. |
| Licensing and trial | The first launch with no license starts a **30-day full-feature (Ultimate) trial**, which **requires internet**. [OFFICIAL] Reinstalling usually does not grant a new trial [community moderator]. |
| License types | **Standalone**: one PC, internet needed only to activate or deactivate, and deactivation needs admin. **Floating**: needs a permanent internet connection and is activated with a share code (`license.share_code` in auto.cfg). On-prem license servers were dropped in 2.5.0. [OFFICIAL] Cloning a licensed VM is [UNVERIFIED]. |
| Editions | **Ultimate**: all drivers, **Web API**, SDK; from €28/mo, €278/yr or €765 one-time. **Modbus & OPC**: Modbus TCP Server/Client and OPC; from €17/mo, €158/yr or €435 one-time. **Siemens Edition**: same price as Modbus & OPC. **Starter**: only the Control I/O driver. [OFFICIAL factoryio.com/editions; prices as listed when searched] **MongoMation needs Ultimate** (Web API plus Modbus). |
| Versions | 2.4.6: web server. 2.5.2: force and failure verbs. 2.5.6: Modbus Server answers unit ID 0/255, and NO/NC push buttons were added. 2.5.7–2.5.10: maintenance; nothing Modbus- or web-related. [OFFICIAL] |
| I/O rate | Not documented. The SDK sample cycle is 8 ms. Plan for an OpenPLC poll of 50–100 ms plus the PLC scan time, and keep Web API polling at 5–10 Hz. [OFFICIAL SDK + INFERRED] |
| Ports to open | 7410/TCP (Web API) and 502/TCP (Modbus Server), inbound on the Windows host, plus 8080 for the OpenPLC UI wherever OpenPLC runs. |

---

## 7. Sources

**Official (Real Games)**

- Web API: https://docs.factoryio.com/manual/web-api/
- Console: https://docs.factoryio.com/manual/console/
- Tags: https://docs.factoryio.com/manual/tags/
- Failure injection: https://docs.factoryio.com/manual/failure-injection/
- Drivers: https://docs.factoryio.com/manual/drivers/
- Modbus server: https://docs.factoryio.com/manual/drivers/modbus-server/
- Modbus client: https://docs.factoryio.com/manual/drivers/modbus-client/
- Scenes: https://docs.factoryio.com/manual/scenes/
- Operators: https://docs.factoryio.com/manual/parts/operators/
- Sensors: https://docs.factoryio.com/manual/parts/sensors/
- Stations: https://docs.factoryio.com/manual/parts/stations/
- System requirements: https://docs.factoryio.com/manual/system-requirements/
- Licensing: https://docs.factoryio.com/manual/licensing/
- Installing: https://docs.factoryio.com/installing/
- Release notes: https://docs.factoryio.com/release-notes/
- Edit and Run: https://docs.factoryio.com/manual/edit-and-run/
- Creating a scene: https://docs.factoryio.com/getting-started/creating-a-scene/
- Controlling with a PLC: https://docs.factoryio.com/getting-started/controlling-with-a-plc/
- CODESYS Modbus tutorial: https://docs.factoryio.com/tutorials/codesys/setting-up/codesys-mb-sp16/
- Help center articles:
  - https://factoryio.helpscoutdocs.com/article/21-command-line-arguments
  - https://factoryio.helpscoutdocs.com/article/22-load-scene-at-startup
  - https://factoryio.helpscoutdocs.com/article/20-customize-factory-io-at-startup-configuration-files
  - https://factoryio.helpscoutdocs.com/article/30-how-to-export-tags
  - https://factoryio.helpscoutdocs.com/article/32-camera-not-moving-when-running-on-a-virtual-machine
  - https://factoryio.helpscoutdocs.com/article/26-install-in-silent-mode
- Community posts:
  - 2.4.6 preview: https://community.factoryio.com/t/factory-i-o-v2-4-6-preview-2-available/618
  - WebAPI + OpenPLC: https://community.factoryio.com/t/factoryio-2-5-2-webapi-openplc-driver/1739
  - Webserver + Control I/O: https://community.factoryio.com/t/webserver-control-i-o-driver/1320
  - Load a scene at startup: https://community.factoryio.com/t/load-a-scene-at-startup/26
- Editions: https://factoryio.com/editions/
- SDK repo: https://github.com/realgamessoftware/factoryio-sdk (`README.md`, `RESERVED ADDRESSES.md`, `samples/Controllers/Program.cs`, `samples/Controllers/Scenes/*.cs`)

**OpenPLC**

- https://github.com/thiagoralves/OpenPLC_v3: `webserver/webserver.py` (Slave Devices banner, settings), `webserver/pages.py` (add-device form), `webserver/core/modbus_master.cpp` (polling and mapping), `webserver/core/modbus.cpp` (slave address ranges)
- https://github.com/Autonomy-Logic/openplc-runtime: v4 modbus master plugin

**Third-party evidence** (primary artifacts produced by Factory I/O, or working code)

- Web API transcription: https://github.com/api-evangelist/factory-i-o (`openapi/_original/factory-i-o-web-api.yaml`)
- Scene XML (.factoryio):
  - MF-Merbouni/Conveyor-Sorting-By-Height-System-Automation (2.5.4)
  - Souf31/modbus-tcp (2.5.7)
  - ivanmartinotto/projeto_Final_SIAI (2.5.10)
  - n1lby73/youtube-automation-documentation (From A to B, 2.5.8)
  - XIIIJASON/Codesys (Filling Tank, 2.5.10)
  - lmtriwork/Factoryio-Projects (modified; used only for GUIDs and layout)
  - rheradio/FactoryIO (Level Control, 2.2.3)
- Real config.cfg / auto.cfg:
  - nobrackets-ctf/NoBrackets-2024 (`finale/Hardware/factory_hacking/src/config.cfg`, `…/Documents/Factory IO/auto.cfg`)
  - lollo1111/Masterarbeit-LP (`factoryio/auto.conf`)
- Captures of all tags: lordmoses/SCAPHY (`Physical-Process/ALL_TRAIN_AND_TEST_DATA/**/CycleValues.arff`)
- Modbus tag exports and Web API run/stop scripts: nesfit/bonnet-ics-library (`imadics/source/ModbusFactory/Scenes/Tags_*_Modbus.csv`, `README.md`, `New-Dataset.ps1`)
- Web API clients:
  - ioloEJ42/FactoryIO-Interface (`Interface/src/api/factoryIO.ts`)
  - Youssef-AMARZOU/scada-hmi (`electron/services/factoryio-service.js`)
  - Mikecranesync/factorylm (`sim/sorting_controller.py`, `cookoff/FIXES.md`, `cookoff/EVIDENCE.md`)
- Sorting by Height (Advanced) I/O list: HoraEmbedded/industrial-sorting-digital-twin (`docs/en/io-mapping.md`)
- OpenPLC with Factory I/O tutorials (search extracts only):
  - https://www.josephgardiner.com/setting-up-openplc-with-factoryio/
  - https://samsclass.info/OT/proj/OT121.htm
  - https://rodrigocantera.com/en/virtual-industrial-cybersecurity-lab-part-4-program-the-control-logic/
