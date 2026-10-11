# MongoMation integration contract — Developer 1 (AWS / simulation) ↔ Developer 2 (app / agent)

Version 1 · 2026-10-11 · Owners: both. Change it only together; note the change at the bottom.

**Goal:** both developers work in parallel. Developer 1 delivers a private, reachable **rig** (Factory I/O + OpenPLC +
Modbus + DCV) and a **verified scene registry**. Developer 2's worker drives it over HTTP only. Nothing here is
public except the DCV viewer (team IPs only) and the Modelence dashboard.

---

## 1. Topology

```
                Internet                          AWS VPC (private subnets)
┌───────────────────────────┐        ┌────────────────────────────────────────────────────────────┐
│ Modelence dashboard (web) │        │  Worker host (Linux EC2, Node 22)  ── HTTP ──▶ OpenPLC runtime │
│   reads Atlas, inserts    │        │    npm run worker                   (8080 v3 / 8443 v4)       │
│   `jobs` only             │        │        │                                   │ Modbus TCP 502    │
└────────────┬──────────────┘        │        └── HTTP (Web API) ──▶ Factory I/O ◀┘ (Factory I/O =   │
             │                       │                              Windows GPU EC2   Modbus server)  │
             ▼                       │                                  ▲                            │
   MongoDB Atlas sandbox ◀───────────┼── worker writes all state        │ Amazon DCV (8443, team IPs) │
   (org "SFTW: Harness Engineering   │                                                               │
    & Model Wrangling Hackathon")    └────────────────────────────────────────────────────────────┘
```

- **Worker placement (pick one, tell Developer 2):**
  - (a) **Recommended:** small Linux EC2 (t3.small/medium, Ubuntu 24.04) in the same VPC/subnet. It needs `git`, Node 22,
    `build-essential flex bison autoconf automake` (to build the MatIEC preflight compiler), outbound HTTPS to Atlas,
    `api.anthropic.com`, Raindrop. SSH for Developer 2.
  - (b) The Windows host itself (Node 22 for Windows); the MatIEC preflight is then skipped (the OpenPLC runtime
    compile still runs).
- **Security groups:** worker → OpenPLC HTTP port and → Factory I/O Web API port only. OpenPLC ↔ Factory I/O Modbus
  502 inside the VPC only. DCV from team IPs only. **No industrial port is ever opened to 0.0.0.0/0.**
- **Atlas Network Access:** add the worker's egress IP (NAT/EIP), both laptops, and Modelence Cloud egress (or 0.0.0.0/0
  for the event day only, with strong DB passwords).

## 2. What Developer 1 delivers (acceptance checklist)

| # | Deliverable | Acceptance test (run from the worker host) |
|---|---|---|
| D1 | Factory I/O (Ultimate ≥ 2.5.2) running the registered scene, **Web API enabled** (§4), driver = Modbus TCP/IP Server | `curl $FACTORYIO_URL/api/tags` returns the scene's tags |
| D2 | OpenPLC runtime (v4 or v3 — say which) with a user for the worker | §3 sequence works with the probe program (`docs/probe-sorting-by-height-basic.st`) |
| D3 | OpenPLC polls Factory I/O as Modbus master (§5 mapping; on v4 the worker ships the Modbus config) | with the probe running, every actuator in Factory I/O switches on for 1 s in the §6 order |
| D4 | `scenes/<scene-id>.json` confirmed (§6): exact tag names, addresses, `activeLow` flags, faultable sensors | Developer 2 runs `npm run seed`; scene shows `VERIFIED` only after D3 passed for every tag |
| D5 | Amazon DCV URL for the 3D view | opens from team laptops |
| D6 | Scene reset between test suites works through the Web API (`FACTORY I/O (Reset)` pulse, `Emitter` force) | §4.2 calls succeed from the worker host |
| D7 | Worker host per §1 with SSH access | `node -v` = 22.x |

**Sorting by Height (Basic) is pre-filled** (`scenes/sorting-by-height-basic.json`: the scene's default Modbus layout and Web
API ids). For that scene, D4 is just: run the probe, confirm, set `verified: true`.

Hand-off message to Developer 2 (paste into chat):
```
OPENPLC_FLAVOR=v4|v3|v3-web
OPENPLC_URL=https://<private-ip>:8443   (v3 web UI: http://<ip>:8080)
OPENPLC_USER=...            OPENPLC_PASSWORD=...
FACTORYIO_URL=http://<private-ip>:7410
FACTORYIO_MODBUS_HOST=<Factory I/O private IP>   (v4: goes into conf/modbus_master.json)
SCENE_ID=<id>               (scenes/<id>.json pushed / sent)
DCV_URL=https://...
WORKER_HOST=ubuntu@<ip>     (or "windows host")
```

## 3. OpenPLC — the calls the worker makes

The worker never needs a browser. It must be able to, over HTTP from the worker host:
1. authenticate, 2. upload a Structured Text program, 3. compile it **with the runtime's own toolchain** and read the
compiler log, 4. start the PLC, 5. read status, 6. stop. Exact sequences per flavor: **§3.1 (v4)** / **§3.2 (v3)**.

Program format produced by the worker (verified to compile with MatIEC `iec2c` + `g++` exactly as OpenPLC v3's
`compile_program.sh` does): one `PROGRAM mongomation_main` with located variables in their own `VAR` block, internal
variables in a second `VAR` block, and
```
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : mongomation_main;
  END_RESOURCE
END_CONFIGURATION
```

Detect the flavor: `GET /api/version` → 200 `{"version":"v4.x"}` on v4; 401 with header `X-OpenPLC-Runtime-Version: v3` on v3.

### 3.1 OpenPLC Runtime **v4** (≥ 4.1; HTTPS :8443, self-signed cert, JWT) — verified end-to-end on v4.3.0 during prep

**v4 does not accept `.st`.** Since 4.1 the compiler is **STruC++** and it runs on the *client*: the worker compiles ST
with the STruC++ npm package (pinned v0.7.0, the version Editor 4.3.2 uses), builds the runtime ZIP and uploads it; the
runtime only runs `g++` and loads the result.

| Step | Call |
|---|---|
| first user (only while none exists) | `POST /api/create-user` `{"username","password"}` |
| login (token lives **15 min**, re-login on 401) | `POST /api/login` → `{"access_token"}` |
| upload | `POST /api/upload-file` multipart `file=program.zip` → `{"UploadFileFail":"","CompilationStatus":"COMPILING"}` |
| compile result | poll `GET /api/compilation-status` → `SUCCESS` / `FAILED` + `logs` |
| start | `GET /api/start-plc` (retry on `COMMAND:BUSY`) |
| confirm | poll `GET /api/status` until `STATUS:RUNNING` (`STATUS:EMPTY` = no program) |

**Two hazards (seen on the real runtime):** (1) a failed on-device build deletes the running program — the worker
preflights first and re-uploads the last good ZIP on failure; (2) every upload replaces plugin config — the worker ships
`conf/modbus_master.json` (generated from `scenes/<id>.json`) inside **every** ZIP, so **Developer 1 does not configure
Modbus in the v4 UI**: give us the Factory I/O private IP (`FACTORYIO_MODBUS_HOST`), port 502, slave id 1.

Developer 1 for v4: run the runtime (Docker image or `install.sh`), create the worker's user, open 8443 to the worker
only, and allow the runtime host to reach Factory I/O:502.

### 3.2 OpenPLC **v3** (fallback; accepts raw `.st`, compiles on-device with MatIEC)

- REST (HTTPS :8443, JWT): same `login` / `upload-file` (`program.st`, `text/plain`) / `compilation-status` / `start-plc` /
  `status` paths as v4. Slave devices can't be configured over REST — do it once in the web UI.
- Web UI (HTTP :8080, cookie; default `openplc`/`openplc` — change it): `POST /login` → `POST /upload-program` →
  `POST /upload-program-action` → `GET /compile-program?file=…` → poll `GET /compilation-logs` → `GET /start_plc`.
- **Slave device for Factory I/O (Developer 1, once, web UI → Slave Devices → Add):** Generic Modbus TCP Device,
  IP = Factory I/O host, port 502, slave id 1, DI start 0 size 14, Coils start 0 size 10, IR start 0 size 0,
  Holding read 0/0, Holding write start 0 size 1 (for Sorting by Height Basic). Polling 100 ms.
  Settings: keep `device_hostname` = the machine's hostname (otherwise v3 renames the host).

Worker settings: `OPENPLC_FLAVOR=v4 | v3 | v3-web`, `OPENPLC_URL`, `OPENPLC_USER`, `OPENPLC_PASSWORD`,
`OPENPLC_INSECURE_TLS=true` (self-signed cert, VPC only), and for v4 `FACTORYIO_MODBUS_HOST`.

Note: with Modbus `error_handling: set-to-zero`, active-low safety inputs (Stop, E-stop) read FALSE while the link is
down, which trips fault latches — the worker pulses Reset once Factory I/O is connected.

## 4. Factory I/O — the calls the worker makes

The worker needs, over HTTP: list tags (name, id, type, sensor/actuator, current value, forced flag), read values,
**force** a sensor value (fault injection, button presses), **release** forced tags. It never writes actuators and never
changes the scene. Every force is released in `finally`, on worker start, and before every test run.

### 4.1 Requirements on the Factory I/O host (Developer 1)

- **Factory I/O Ultimate** (the Web API needs Ultimate; the 30-day trial is Ultimate), version **≥ 2.5.2** (force/release
  endpoints). Windows + DirectX GPU (g4dn/g5) with Amazon DCV.
- Enable the Web API **and** make it start with the scene: `C:\ProgramData\Real Games\Factory IO\auto.cfg`
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
  (Save the built-in scene to *My Scenes* with the **Modbus TCP/IP Server** driver selected — built-ins are read-only.
  If the driver's mapping is empty in your copy, drag the tags in F4 in the §6 order and save.)
- Windows firewall: allow inbound **7410** (Web API) and **502** (Modbus) **from the VPC only**. The Web API has no auth.

### 4.2 Endpoints the worker uses (Factory I/O docs; batch calls return per-item `{code, error}` — all checked)

| Purpose | Call |
|---|---|
| Tag index (id, kind, type, value, `isForced`, `forcedValue`) | `GET /api/tags` |
| Sample all values (one request per 50 ms tick) | `GET /api/tag/values` (no body) |
| Press a button / block an eye / inject a stuck sensor | `PUT /api/tag/values-force` `[{"id":"…","value":true}]` |
| Release | `PUT /api/tag/values-release` `["<id>", …]` |
| Stop / restore box generation around tests | force `Emitter` (Output) `false` / `true` |
| Reset the scene between suites | pulse `FACTORY I/O (Reset)` (Output) via `PUT /api/tag/values` |

Gotchas we handle: names aren't unique (ids resolved by name **and** kind), sensors can only be forced (not written),
NC buttons and retroreflective eyes are **active-low**, Emitter/Remover are **pre-forced TRUE** in built-in scenes (we
never blanket-release outputs), `fetch` can't send GET bodies.

Quick check from the worker host:
```bash
curl -s http://<fio-ip>:7410/api/tags | head -c 400
curl -s -X PUT -H 'Content-Type: application/json' -d '[{"name":"Start","value":true}]' http://<fio-ip>:7410/api/tag/values-force/by-name
curl -s -X PUT -H 'Content-Type: application/json' -d '["Start"]' http://<fio-ip>:7410/api/tag/values-release/by-name
```

### 4.3 Recommended demo scene: **Sorting by Height (Basic)**

Full operator panel, all-digital I/O, rich faults (jam at the pallet sensor, blocked exit eye, stuck height sensor).
Its default Modbus layout and Web API ids are already in `scenes/sorting-by-height-basic.json` (14 DI, 10 coils,
1 holding register). Developer 1 only has to confirm it on the live rig with the probe program
(`docs/probe-sorting-by-height-basic.st`, compiled OK with MatIEC) and flip `verified` to `true`.
Second scene if time allows: **Level Control** (analog, PID-style) — not wired into the validator yet.

## 5. Modbus / address convention (OpenPLC master ↔ Factory I/O Modbus TCP Server)

| Factory I/O side | Modbus table | OpenPLC located variable |
|---|---|---|
| Sensors (Bool: buttons, photo-eyes, limit switches) | Discrete inputs from offset 0 | `%IX100.0`, `%IX100.1`, … `%IX100.7`, `%IX101.0`, … |
| Actuators (Bool: conveyors, lights, pushers) | Coils from offset 0 | `%QX100.0`, `%QX100.1`, … |
| Sensors (Int/Float: level meters, scales, counters) | Input registers from 0 | `%IW100`, `%IW101`, … |
| Actuators (Int/Float: displays, analog valves) | Holding registers from 0 | `%QW100`, `%QW101`, … |

(OpenPLC v3 maps the first Modbus slave device's I/O to `%IX100.0` / `%QX100.0` / `%IW100` / `%QW100`.)
The order of tags in the Factory I/O driver window = the address order. Record it exactly in §6.

## 6. Scene registry format (`scenes/<scene-id>.json`) — validated by `packages/types` `SceneDefinition`

```json
{
  "id": "sorting-by-height-basic",
  "factoryIoScene": "Sorting by Height (Basic)",
  "title": "Sorting station",
  "description": "Entry conveyor, height sensor, pusher to side lane, exit sensor, control panel",
  "capabilities": ["conveyor", "photoelectric", "pusher", "pushbutton", "light"],
  "tags": [
    { "name": "Start", "role": "sensor", "dataType": "BOOL", "plcAddress": "%IX100.0", "kind": "pushbutton", "activeLow": false, "description": "green panel button" },
    { "name": "Stop", "role": "sensor", "dataType": "BOOL", "plcAddress": "%IX100.1", "kind": "pushbutton", "activeLow": true },
    { "name": "Entry conveyor", "role": "actuator", "dataType": "BOOL", "plcAddress": "%QX100.0", "kind": "conveyor" }
  ],
  "faults": [
    { "id": "exit-stuck-on", "title": "Exit photo-eye stuck ON", "kind": "stuck_on", "tag": "At exit", "value": true, "description": "simulates a jammed box / dirty lens" }
  ],
  "timing": { "samplePeriodMs": 50, "settleMs": 1500 },
  "verified": false
}
```
Rules: `name` = exact Factory I/O tag text; `role` sensor = PLC input, actuator = PLC output; set `activeLow: true` for
inputs that read FALSE when active: Stop and Emergency stop buttons (NC) and retroreflective eyes (FALSE when blocked);
`verified: true` only after the D3 probe passed.
Generate the probe for a scene file with `npx tsx scripts/gen-probe.ts scenes/<id>.json > probe.st`.

## 7. What Developer 2 guarantees

- The worker only: uploads/compiles/starts/stops programs on OpenPLC; reads tags; forces/releases **sensor** tags on
  Factory I/O. No scene edits, no actuator writes, no other hosts.
- A single rig lock in Atlas: one job at a time on the rig; benchmark runs queue behind live demos.
- Faults are always released (finally-blocks, worker start, before every test). `rig_status.forced` on the dashboard
  shows any forced tag live.

## 8. Timeline (proposal)

| By | Who | What |
|---|---|---|
| T+1h | Dev 1 | D7 worker host, D2 OpenPLC reachable, Factory I/O Web API answering (D1) |
| T+2h | Dev 1 | D3 Modbus mapping verified with the probe; D4 scene file for the demo scene; D5 DCV |
| T+2h | Dev 2 | worker + dashboard running against Atlas; preflight compiler built on the worker host |
| T+3h | both | first real run: spec → compile → deploy → measured tests |
| T+4h | both | fault injection demo + first RSI round; freeze; record video |

## Change log
- v1 (2026-10-11): initial contract, with OpenPLC v4.3 and Factory I/O Web API details from the prep research.
