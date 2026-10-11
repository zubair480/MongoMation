# OpenPLC headless compile + deploy: developer reference (MongoMation)

Researched 2026-10-11. `SCRATCH` = `/tmp/claude-0/-home-user-random/d8420e0c-0e81-55bf-af8c-e12a84d53953/scratchpad`.
Sources were cloned into `$SCRATCH/refs/`. Samples, scripts and logs are in `$SCRATCH/research/openplc_samples/`.

How each claim was checked:

- **[RUN]**: executed in this container against the real code. Runtime v4.3.0 was built from source and run, STruC++ 0.7.0 was run, and matiec was built from `OpenPLC_v3/utils/matiec_src`.
- **[SRC]**: read from source code at the commit listed in §1, but not executed.
- **[UNVERIFIED]**: taken from docs, comments or web-search snippets only.

---

## 0. Key findings (read first)

1. **Runtime v4 does not accept a `.st` file.** `POST /api/upload-file` only accepts a ZIP in the multipart field `file`. **[RUN]** A raw `.st` upload returns `{"CompilationStatus":"FAILED","UploadFileFail":"Uploaded ZIP file failed safety checks"}`, and compilation-status logs `[ERROR] Not a valid PLC Program file.`
2. **Since runtime v4.1.0 the compiler is STruC++, not matiec.** STruC++ turns ST into C++.
   - The ST→C++ step runs on the client: in the Editor, or in our agent.
   - The runtime only runs `g++` through `scripts/Makefile.strucpp`, building `build/libplc_<ts>.so`. It then `dlopen`s that file.
   - `scripts/compile.sh` refuses MatIEC uploads (`Config0.c`/`glueVars.c`) with exit 2.
   - Runtime tags v4.0.0–v4.0.9 were the MatIEC era.
   - Current versions are runtime **v4.3.0** (main, 2026-10-07) and Editor **v4.3.2**. The Editor pins **STruC++ v0.7.0** in `binary-versions.json`.
3. **STruC++ is a pure TypeScript npm package**, shipped as a GitHub release asset: `https://github.com/Autonomy-Logic/STruCpp/releases/download/v0.7.0/strucpp-0.7.0.tgz`. Its only dependency is `chevrotain`, and it needs Node ≥ 22. Our agent can call `compile()` with the same options the Editor uses, then build the runtime ZIP itself. **[RUN]**
4. **The whole v4 flow was verified on runtime v4.3.0 [RUN]:**
   - STruC++ bundle → upload → on-device compile `SUCCESS` (about 3 s) → `START:OK` → `STATUS:RUNNING`.
   - The `modbus_master` plugin polled a stand-in Factory I/O Modbus server:
     - discrete inputs reached `%IX100.0..5`;
     - `%QX100.0..3` were written to coils 0..3;
     - `%QW100` was written to holding register 0.
   - The conveyor logic behaved correctly: start, run, part counting, e-stop, fault latch and reset.
5. **A failed on-device build destroys the running program. [RUN]**
   - `compile-clean.sh` runs even when the build failed. It does `rm -f build/libplc_*.so` before its `mv`, and the `mv` fails.
   - The runtime then reports `STATUS:EMPTY`, and `/api/start-plc` still answers `START:OK`.
   - The build log claims "PLC program has not been updated", which is misleading.
   - So: always preflight locally, poll `/api/status` after start, and keep the last good ZIP for rollback.
6. **Every upload replaces the plugin configuration. [RUN]**
   - An upload without a `conf/` directory disables all plugins, so Modbus I/O stops.
   - Ship `conf/modbus_master.json` (and/or `conf/modbus_slave.json`) in every ZIP.
7. **The JWT access token expires after 15 minutes.** This is the flask-jwt-extended default; nothing sets `JWT_ACCESS_TOKEN_EXPIRES`. **[RUN]** The token showed `exp − iat = 900 s`. `docs/API.md` says "24 hours", which is wrong. Log in again on 401.
8. **OpenPLC v3 fallback accepts a raw `.st`** and compiles on the device with matiec (`iec2c`). It offers two interfaces:
   - the legacy web UI on HTTP :8080, using a session cookie;
   - a REST API on HTTPS :8443, using JWT and the same paths as v4.

   The v4 Editor itself uploads `program.st` to v3 through `/api/upload-file`. **[SRC]**
9. **matiec (v3) is much stricter than STruC++ (v4).** Generate ST in the intersection of the two dialects (§6.5) and preflight with both: `preflight_matiec.sh` and `preflight_v4.sh`.

---

## 1. Sources examined

| Repo | Ref | Commit | Date |
|---|---|---|---|
| Autonomy-Logic/openplc-runtime | `main` (default branch; `development` has the identical tree at 25dd6c6) | a9e38d9 | 2026-10-07, `VERSION` = v4.3.0 |
| Autonomy-Logic/openplc-runtime | tag `v4.0.9` (MatIEC-era comparison) | – | – |
| Autonomy-Logic/openplc-editor | `main` | 37cdb6a | 2026-09-28, package.json 4.3.2 |
| Autonomy-Logic/STruCpp | tag `v0.7.0` + release tgz | 72dfcb8 | 2026-09-28 |
| thiagoralves/OpenPLC_v3 | `master` | b5d4135 | 2026-04-04 |
| matiec | `OpenPLC_v3/utils/matiec_src` (iec2c reports "matiec version 0.1") | same as v3 | – |

Runtime tags run up to v4.3.0. The v4.0.x line is MatIEC; v4.1.0 and later use STruC++. Editor tags run up to v4.3.2.

---

## 2. OpenPLC Runtime v4 (v4.3.0)

### 2.1 Architecture [SRC, confirmed by RUN]

The runtime has two processes:

- **Process 1: the webserver.** `python3 -m webserver.app` runs Flask, Flask-JWT-Extended, Flask-SocketIO and SQLite, behind a Werkzeug HTTPS server on `0.0.0.0:8443`.
- **Process 2: the real-time core.** `build/plc_main` is C/C++ with SCHED_FIFO scheduling. The webserver spawns and monitors it.

IPC between them:

- The command socket is `/run/runtime/plc_runtime.socket`. It speaks a line protocol: `START`, `STOP`, `STATUS`, `PING`, `STATS`, `SWITCH`, `DEBUG:<hex>`, `PLUGIN_CMD:<name>:<json>`. The REST answers in §2.5 are these replies with whitespace stripped.
- The log socket is `/run/runtime/log_runtime.socket`.

Program loading and supervision:

- The user program is `build/libplc_<epoch_ns>.so`, which `plc_main` `dlopen`s.
- `plc_main` **auto-starts the last program at boot** (`plc_main.c`, skipped in safe mode). **[RUN]**
- If `plc_main` dies, the webserver restarts it.
- Three crashes within 30 s, or watchdog exit code 42, restart it in **safe mode**: the program is not loaded until a new upload.

Plugins are listed in `plugins.conf` (copied from `plugins_default.conf`):

- Python plugins: `modbus_slave`, `modbus_master`, `opcua`. They run in embedded CPython, each with its own venv `./venvs/<name>`.
- Native plugins: `s7comm`, `ethercat`.

Other facts:

- There is **no browser UI** on 8443, only the API.
- The persistent directory holds `.env` (generated `JWT_SECRET_KEY` and `PEPPER`) and `restapi.db` (users). It is `/var/lib/openplc-runtime` on native Linux and `/var/run/runtime` in a container. Override it with `OPENPLC_PERSISTENT_DATA_DIR` (and `OPENPLC_RUNTIME_DIR`).
- The image tables have `BUFFER_SIZE` 1024, so valid ranges are `%IX/%QX 0.0–1023.7` and `%IW %QW %MW %MD %ML` 0–1023 (`core/src/plc_app/image_tables.h`).

### 2.2 Install / start

**Docker [SRC]** (README, `.github/workflows/docker.yml`). Multi-arch images exist for linux/amd64, arm64 and arm/v7. Tags are `:latest` (stable releases) and `:vX.Y.Z`. Pin a version:

```bash
docker run -d --name openplc-runtime \
  -p 8443:8443 \
  --cap-add=SYS_NICE --cap-add=SYS_RESOURCE \
  -v openplc-runtime-data:/var/run/runtime \
  ghcr.io/autonomy-logic/openplc-runtime:v4.3.0      # or :latest
# add -p 502:502 only if the project enables conf/modbus_slave.json
# healthcheck the image uses: curl -kfsS https://127.0.0.1:8443/api/version
```

**Linux one-liner [SRC].** This is the officially recommended path:

```bash
curl -fsSL https://runtime.getedge.me | sudo bash
# same script: https://raw.githubusercontent.com/Autonomy-Logic/openplc-runtime/main/scripts/install-docker.sh
# uninstall: curl -fsSL https://runtime.getedge.me | sudo bash -s -- --uninstall --yes   (add --purge to delete data)
```

- It installs Docker.
- It starts a **bootloader** container (`ghcr.io/autonomy-logic/openplc-runtime-bootloader`, `--network host`, API on https :8445).
- The bootloader runs the runtime container with **`--network host`**, with data in `/var/lib/openplc-runtime`. This means ports 8443 and 502 bind directly on the host.

**Native from source [SRC]:**

```bash
git clone https://github.com/Autonomy-Logic/openplc-runtime.git && cd openplc-runtime
sudo ./install.sh --native      # deps, venvs, cmake build, plugin builds, systemd unit "openplc-runtime"
sudo ./start_openplc.sh         # also creates plugin venvs from requirements.txt
```

It needs CMake ≥ 3.28 (the installer downloads it if older), Python ≥ 3.10 and root.

**Windows [SRC, not tested].** CI builds an Inno Setup installer with a bundled MSYS2. It installs per-user to `%LOCALAPPDATA%\OpenPLC Runtime\` and starts with `StartOpenPLC.bat`. The API is the same on :8443. TCP/UDP communication FBs are stubbed out on Windows.

**What ran here [RUN].** Ubuntu 24.04 container, about 2 minutes:

```bash
cp -a refs/openplc-runtime refs/openplc-runtime-build && cd refs/openplc-runtime-build
python3 -m venv venvs/runtime && venvs/runtime/bin/pip install -r requirements.txt && venvs/runtime/bin/pip install -e .
mkdir -p build && cd build && cmake .. && make -j"$(nproc)" && cd ..
# plugin venv MUST use the same Python minor version plc_main embeds (ldd: libpython3.12 here)
python3.12 -m venv venvs/modbus_master && venvs/modbus_master/bin/pip install pymodbus==3.11.2 "pyserial>=3.5"
OPENPLC_PERSISTENT_DATA_DIR=$SCRATCH/v4data venvs/runtime/bin/python3 -m webserver.app   # run as root
```

Sandbox limits that do not apply on AWS:

- The official ghcr image could not be pulled here, because egress policy blocked the blob host `pkg-containers.githubusercontent.com`.
- `docker build` of the repo failed here because `deb.debian.org` does not resolve in this sandbox.

### 2.3 TLS

- A self-signed certificate is generated at first start: `webserver/certOPENPLC.pem` and `webserver/keyOPENPLC.pem`. **[RUN]**
  - `CN=localhost`, SAN `DNS:localhost, IP:127.0.0.1`, valid 100 years.
- The certificate does not contain the AWS IP. Clients should do one of these:
  - **pin** the PEM as their CA and turn hostname checking off (`deploy_v4.py --cafile`, verified);
  - disable verification, as the Editor does (`rejectUnauthorized:false` / `curl -k`).
- With the Docker one-liner, the PEM lives inside the container at `/workdir/webserver/` **[SRC]**. Fetch it once with `docker cp`, or capture it with `openssl s_client -connect host:8443`.

### 2.4 Authentication [RUN]

1. **Check for users.** `GET /api/get-users-info` without a token returns `404 {"msg":"No users found"}` on a fresh runtime, or `200 {"msg":"Users found"}`.
2. **Create the first user.** `POST /api/create-user`, `Content-Type: application/json`, body `{"username":"mongo","password":"..."}` → `201 {"id":1,"msg":"User created","role":"admin"}`.
   - Creation is unauthenticated **only while the user table is empty**. After that the call needs an admin JWT, otherwise `401 {"msg":"Authentication required"}`.
   - The first user is always `admin`. Later users take an optional `"role":"admin"|"user"` (default `user`).
   - Both roles may upload, start, stop, read status and read logs. Only admin can manage users and use `/api/project-snapshot`.
3. **Log in.** `POST /api/login` with `{"username","password"}` → `200 {"access_token":"<HS256 JWT>"}`. Bad credentials give `401 "Wrong username or password"` (a bare JSON string).
4. **Authorize requests.** Send `Authorization: Bearer <token>` on every other call.
   - The token lasts **15 min**. There is no refresh token; call `/api/login` again.
   - A missing header gives `401 {"msg":"Missing Authorization Header"}`.
   - A garbage token gives `422`.
   - After `POST /api/logout` the token gives `401 {"msg":"Token has been revoked"}`. The blacklist is in memory and clears on restart.
   - An expired token gives `401` with `{"msg":"Token has expired"}`. That text is the flask-jwt-extended default and was not observed here.

### 2.5 Every route in v4.3.0 [SRC; ★ = exercised in RUN]

Base URL: `https://<host>:8443`. Every `/api` response carries the header `X-OpenPLC-Runtime-Version: v4.3.0` ★.

| Method & path | Auth | Request | Response (HTTP 200 unless noted) |
|---|---|---|---|
| ★GET `/api/version` | none | – | `{"version":"v4.3.0"}` |
| ★GET `/api/capabilities` | none | – | `{"runtimeVersion":"v4.3.0","minEditorVersion":"4.1.0","projectSnapshot":true}` |
| ★GET `/api/get-users-info` | optional | – | no JWT: 404 `{"msg":"No users found"}` / 200 `{"msg":"Users found"}`; with JWT: `[{"id","username","role"}]` |
| ★POST `/api/create-user` | none for the first user, then admin | `{"username","password"[,"role"]}` | 201 `{"msg":"User created","id","role"}`; 400/401/403/409 `{"msg":...}` |
| ★POST `/api/login` | none | `{"username","password"}` | `{"access_token":...}` / 401 |
| ★POST `/api/logout` | JWT | – | `{"msg":"User logged out successfully"}` |
| ★GET `/api/whoami` | JWT | – | `{"id","username","role"}` |
| GET `/api/get-user-info/<id>` | JWT | – | `{"id","username","role"}` |
| PUT `/api/update-user/<id>` | JWT (self or admin) | `{"username"?,"password"?,"current_password"? (self pw change),"role"? (admin)}` | `{"msg":"User updated successfully","user":{...}}` |
| DELETE `/api/delete-user/<id>` | admin, not self | – | `{"msg":"User X deleted successfully"}` |
| GET `/api/project-snapshot` | admin | – | `{"projectName","formatVersion","filename":"project.zip","contentBase64"}` / 404 |
| ★POST `/api/upload-file[?clean=1]` | JWT | multipart: `file` = program.zip (required); optional `snapshot` (zip) + `snapshot_metadata` (JSON) | `{"UploadFileFail":"","CompilationStatus":"COMPILING","ProjectSnapshotWarning":""}`, or `{"UploadFileFail":"<reason>","CompilationStatus":"FAILED"/...}`. Always HTTP 200. |
| ★GET `/api/compilation-status` | JWT | – | `{"status":"IDLE"/"UNZIPPING"/"COMPILING"/"SUCCESS"/"FAILED","logs":["[INFO] ...\n",...],"exit_code":null/0/1/-1}` |
| ★GET `/api/start-plc` | JWT | – | `{"status":"START:OK"}`; also `START:ERROR`, `START:ERROR_ALREADY_RUNNING`★, `START:ERROR_SWITCH_STOP`, `COMMAND:BUSY` |
| ★GET `/api/stop-plc` | JWT | – | `{"status":"STOP:OK"}`, or `STOP:ERROR`★ when not running, or `COMMAND:BUSY` |
| ★GET `/api/status[?include_stats=true]` | JWT | – | `{"status":"STATUS:RUNNING","switchPosition":"run"[,"timing_stats":{"tasks":[{name,scan_count,scan_time_avg,cycle_time_avg,overruns,...}]}]}`. Status values: `STATUS:RUNNING`/`STOPPED`/`EMPTY` (no program)/`ERROR`/`TRANSITIONING`/`INIT`/`UNKNOWN`, or `{"status":"No response from runtime"}` |
| ★GET `/api/ping` | JWT | – | `{"status":"PING:OK"}` |
| ★GET `/api/runtime-logs[?id=<min_id>][&level=INFO/WARNING/ERROR/DEBUG]` | JWT | – | `{"runtime-logs":[{"id":1,"timestamp":"2026-10-11T15:33:54+0000","level":"INFO","message":"..."}]}` (in-memory ring of 1000 entries) |
| GET `/api/serial-ports` | JWT | – | `{"ports":[{"device","description"}]}` |
| ★GET `/api/switch` | JWT | – | `{"switchPosition":"run"}` |
| POST `/api/plugin-command` | JWT | `{"plugin":"name","command":"...","params":{}}` | the plugin's JSON reply |
| ★any other GET `/api/<x>` | JWT | – | 200 `{"error":"Unknown argument"}`; other POSTs give `{"PostRequestError":"Unknown argument"}` |
| GET `/api/discovery/interfaces`, GET `/api/discovery/ethercat/{status,runtime-status,diagnostics}`, POST `/api/discovery/ethercat/{scan,validate,test}` | JWT | – | EtherCAT/network discovery (not needed) |
| Socket.IO, path `/socket.io`, namespace `/api/debug` | JWT in `auth:{token}` | event `debug_command {command:"44 00 03 ..."}` (hex PDU, FC 0x41–0x45, STruC++ debug-map indices), event `reauth` | event `debug_response {success,data}` |
| UDP 33333 | – | LAN discovery responder | – |

**There is no settings or Modbus endpoint.** Plugin configuration (Modbus master/slave, OPC-UA, S7, EtherCAT), retain settings and VPP drivers all travel inside the upload ZIP: `conf/*.json`, `retain.conf`, `vpp_plugins.conf`.

### 2.6 What v4 accepts as a program (≥ v4.1 STruC++ contract)

Entries sit at the ZIP root; the runtime extracts them into `core/generated/`.

| ZIP entry | Required | Source |
|---|---|---|
| `generated.hpp` | **yes** (compile.sh checks it) | STruC++ `result.headerCode` |
| `*.cpp` (≥ 1) | **yes** | STruC++ `result.cppFiles`, e.g. `configuration.cpp` plus one `pou_<NAME>.cpp` per POU |
| `generated_debug.cpp` | effectively yes (runtime shim uses debug tables) | STruC++ `result.debugTableCpp` (`debug:true`) |
| `defines.h` | **yes** (Makefile prerequisite) | `#pragma once\n// Program MD5\n#define PROGRAM_MD5 "<md5 of program.st>"\n` |
| `strucpp_runtime/include/*.hpp` | **yes** (directory checked) | copy of `node_modules/strucpp/src/runtime/include/` (24 headers in 0.7.0) |
| `c_blocks.h` | Editor always sends it | `// Empty file\n` when there are no C/C++ POUs |
| `c_blocks_code.cpp` | only for C/C++ POUs | – |
| `program.st`, `debug-map.json`, `program.st.map.json` | informational (Editor sends them) | – |
| `conf/modbus_master.json`, `conf/modbus_slave.json`, `conf/opcua.json`, `conf/s7comm.json`, `conf/ethercat_busconfig.json` | optional; **presence enables the plugin, absence disables it** | §4 |
| `retain.conf`, `vpp_plugins.conf`, `vpp_plugin/` | optional | – |

Program-level rules:

- **The program must declare `CONFIGURATION Config0`** (any case; STruC++ upper-cases it to `strucpp::Configuration_CONFIG0`). The runtime shim `core/strucpp_runtime/runtime_v4_entry.cpp` instantiates exactly that class.
- **[RUN]** Without it, STruC++ still succeeds, but the on-device g++ fails: `generated_debug.cpp:15:19: error: 'Configuration_CONFIG0' in namespace 'strucpp' does not name a type`.

ZIP limits (`plcapp_management.analyze_zip`):

- ≤ 10 MB per entry, ≤ 50 MB total.
- Compression ratio ≤ 1000.
- No absolute paths, `..` or `:` in names.
- Extensions `.exe .dll .sh .bat .js .vbs .scr` are blocked.
- macOS junk is dropped.
- If **all** entries share a single top-level folder, that folder is stripped.

The v4.0.x legacy format (MatIEC) is shown for reference only; it is rejected by ≥ v4.1. It contained `Config0.c`, `Res0.c`, `debug.c`, `glueVars.c`, `lib/` and `c_blocks_code.cpp`, built with `gcc -w -O3 -fPIC`. Do not target v4.0.x.

### 2.7 On-device compile (what `/api/compilation-status` streams) [RUN]

Sequence after an accepted upload:

1. If the PLC was running, it is stopped first. The log shows `[WARNING] The PLC was running; stopped it before the upload`.
2. The ZIP is extracted, then plugins are reconfigured from `conf/`.
3. `make -j$(min(nproc-1, RAM_GB)) -f scripts/Makefile.strucpp` compiles each `core/generated/*.cpp` with:
   ```
   g++ -std=c++17 -O1 -pipe -fPIC -Wall -DSTRUCPP_THREADED -fno-gnu-unique -MMD -MP \
       -Wno-unknown-pragmas -Wno-deprecated-declarations \
       -I core/generated -I core/generated/strucpp_runtime/include -I core/src/plc_app/include \
       -include iec_python.h -c core/generated/X.cpp -o build/X.o
   ```
   - It also compiles the shim `runtime_v4_entry.cpp` (plus `-DSTRUCPP_SHIM_HAS_RETAIN` when the headers support retain) and `python_loader.c`.
   - Then it links `g++ -shared -fPIC -o build/new_libplc.so ... -lpthread -lrt`.
4. `compile-clean.sh` renames the result to `build/libplc_<ts>.so`. **On a failed build it has already deleted the old .so (§0.5).**
5. Status becomes `SUCCESS` with `exit_code` 0, or `FAILED` with 1 (or −1 if the orchestrator crashed). **The PLC is NOT auto-started after an upload.** The client must call `/api/start-plc`.

Log line conventions:

- Each log line ends in `\n`.
- Compiler stderr lines are prefixed `[ERROR] `, so g++ diagnostics appear as `[ERROR] core/generated/...: error: ...`.
- Other tags: `[INFO]`, `[WARNING]`, `[DEBUG]`.

Busy states:

- An upload during a compile returns `{"UploadFileFail":"Runtime is compiling another program, please wait",...}`.
- A concurrent upload returns `"Another upload is in progress, please wait"`.

### 2.8 Start / status semantics

- `start-plc` returns `COMMAND:BUSY` while the previous STOP or unload is still in progress. The Editor retries every 150 ms for up to 5 s (`start-plc-after-build.ts`).
- `START:OK` only means the transition began. **Poll `/api/status` until `STATUS:RUNNING`.** `STATUS:EMPTY` means no program could be loaded. **[RUN]**
- `START:ERROR_SWITCH_STOP` only occurs with VPP hardware that has a RUN/STOP switch.

### 2.9 Verified transcript (v4.3.0, abridged) [RUN]

```
GET  /api/capabilities      -> {"minEditorVersion":"4.1.0","projectSnapshot":true,"runtimeVersion":"v4.3.0"}
GET  /api/get-users-info    -> 404 {"msg":"No users found"}
POST /api/create-user       -> 201 {"id":1,"msg":"User created","role":"admin"}
POST /api/create-user (2nd, no JWT) -> 401 {"msg":"Authentication required"}
POST /api/login             -> {"access_token":"eyJ..."}   (exp-iat = 900 s)
GET  /api/status            -> {"status":"STATUS:EMPTY","switchPosition":"run"}
GET  /api/compilation-status-> {"exit_code":null,"logs":[],"status":"IDLE"}
POST /api/upload-file (program.zip) -> {"CompilationStatus":"COMPILING","ProjectSnapshotWarning":"","UploadFileFail":""}
GET  /api/compilation-status (3 s later) -> status SUCCESS, exit_code 0, logs: "[INFO] Compiling core/generated/configuration.cpp..." ... "[INFO] Build finished successfully"
GET  /api/start-plc         -> {"status":"START:OK"}
GET  /api/status?include_stats=true -> {"status":"STATUS:RUNNING","switchPosition":"run","timing_stats":{"tasks":[{"name":"TASK0","scan_count":50,...,"overruns":0}]}}
GET  /api/start-plc (again) -> {"status":"START:ERROR_ALREADY_RUNNING"}
GET  /api/stop-plc x2       -> {"status":"STOP:OK"} then {"status":"STOP:ERROR"}
runtime-logs excerpt: "[image_tables] 11 located var(s) via copy-in/out", "PLC base tick: 20000000 ns across 1 task(s)", "PLC State: RUNNING"
```

`deploy_v4.py` runs the full sequence with certificate pinning and exits 0 on `STATUS:RUNNING`. **[RUN]**

### 2.10 Sequence to implement (v4)

```
0. (once)  GET  /api/capabilities           -> require runtimeVersion >= v4.1.0 (STruC++ bundle)
1. (once)  GET  /api/get-users-info          -> 404 => POST /api/create-user {"username","password"}
2.         POST /api/login {"username","password"} -> token (re-login on any 401; 15-min TTL)
3. local:  preflight_v4.sh program.st out/ conf/modbus_master.json   -> out/program.zip (STruC++ + same g++ as device)
4.         POST /api/upload-file  multipart file=@program.zip;type=application/zip  (Bearer)
           -> require UploadFileFail == ""
5.         loop 1 s: GET /api/compilation-status until status in {SUCCESS, FAILED}; stream logs[seen:]
           FAILED => device now EMPTY: re-upload last-known-good zip, report [ERROR] lines to the LLM
6.         loop 150 ms (<= 5 s): GET /api/start-plc while status contains "BUSY"; accept START:OK / ALREADY_RUNNING
7.         loop 200 ms: GET /api/status until STATUS:RUNNING (fail on EMPTY/ERROR)
8.         GET /api/runtime-logs?id=<last_id+1> for runtime errors (e.g. Modbus connection errors)
```

curl equivalent:

```bash
B=https://$PLC:8443/api
curl -sk -X POST $B/create-user -H 'Content-Type: application/json' -d '{"username":"mongo","password":"secret"}'
T=$(curl -sk -X POST $B/login -H 'Content-Type: application/json' -d '{"username":"mongo","password":"secret"}' | jq -r .access_token)
curl -sk -X POST $B/upload-file -H "Authorization: Bearer $T" -F "file=@program.zip;type=application/zip"
curl -sk -H "Authorization: Bearer $T" $B/compilation-status
curl -sk -H "Authorization: Bearer $T" $B/start-plc
curl -sk -H "Authorization: Bearer $T" "$B/status?include_stats=true"
curl -sk -H "Authorization: Bearer $T" "$B/runtime-logs?id=0"
```

---

## 3. OpenPLC Editor v4 (v4.3.2)

### 3.1 How it compiles [SRC]

The shared pipeline lives in `src/backend/shared/compile/pipeline.ts`:

1. **Project IR → ST.** An in-process TypeScript ST transpiler (`backend/shared/transpilers/st-transpiler`) emits `program.st`. It no longer goes through PLCopen XML; the old `xml2st` and `iec2c` are gone. It always emits:
   ```
   CONFIGURATION Config0
     RESOURCE Res0 ON PLC
       TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
       PROGRAM instance0 WITH task0 : main;
     END_RESOURCE
   END_CONFIGURATION
   ```
2. **MD5.** Computes the MD5 of `program.st`.
3. **STruC++ compile.** `strucpp.compile(source, {headerFileName:'generated.hpp', fileName:'program.st', debug:true, lineMapping:true, libraries:<every bundled .stlib + enabled user libs>, md5, pouIncludes: hasCBlocks?['c_blocks.h']:[]})` (`program-build-pipeline.ts`).
   - The Editor first splits per POU, then falls back to a monolithic compile.
   - Bundled libs come from `node_modules/strucpp/libs/*.stlib`: `additional-function-blocks`, `iec-standard-fb`, `iec-std-functions`, `oscat-basic`, `plcopen-softmotion`.
4. **Bundle.** `composeRuntimeV4Bundle` (`middleware/shared/utils/library/compose-runtime-v4-bundle.ts`) builds the file map from §2.6, adds `conf/*.json` produced by `generate*Config`, then zips it with JSZip.
5. **Version check.** `GET /api/capabilities`, falling back to `/api/version`. It requires ≥ 4.1.0, and the Editor itself must be ≥ `minEditorVersion`.
6. **Deploy.** Upload with `POST /api/upload-file` (multipart `file`, filename `program.zip`, optional `?clean=1`, optional snapshot parts), then poll `/api/compilation-status` (1 s, 20 min timeout), then `/api/start-plc` with BUSY retry. See `deploy-runtime-program.ts`, `poll-runtime-compilation.ts`, `start-plc-after-build.ts` and `runtime-api-client.ts`.

For a **Runtime v3** target, the Editor runs STruC++ only as a syntax check. It then uploads `program.st` (`text/plain`) to v3's `/api/upload-file` on :8443 with the same compile-status and start loop. **[SRC]** (`editor-compiler-platform-port.ts` `uploadRuntimeV3`)

### 3.2 Headless options

| Option | Status | Notes |
|---|---|---|
| **A. Replicate the Editor in Node** (recommended) | **[RUN]** | Download `strucpp-0.7.0.tgz`, `npm install --ignore-scripts <tgz>` (pulls `chevrotain` 11.x), then use `research/openplc_samples/build_v4_bundle.mjs`, which mirrors the Editor's options and ZIP layout. Verified to compile and run on runtime v4.3.0. |
| B. `openplc-cli` (Editor's headless CLI, `docs/CLI.md`) | [SRC, not run] | `openplc-cli compile <project> --target "OpenPLC Runtime v4"`; `openplc-cli upload <project> --host <ip> --credentials user:pass --yes [--create-user] [--clean]`. Emits one JSON document on stdout. Exit codes: 0 ok, 2 usage, 3 not found, 4 compile error, 5 connection, 6 auth, 7 target error, 8 timeout. Needs the Electron AppImage plus GTK/NSS libraries, and `--no-sandbox` in containers (`AppImage --no-sandbox --cli install-cli`). Works on an **Editor project directory** (`project.json` + `pous/programs/*.st|.json` + device config), not a bare `.st`, so remote devices would have to be authored in the project files. Targets are `"OpenPLC Runtime v4"` and `"OpenPLC Runtime v3"`. |
| C. STruC++ standalone CLI (`strucpp in.st -o out.cpp`) | [SRC] | Produces only `.cpp`/`.hpp`, without the runtime-specific `generated_debug.cpp`, `defines.h` or ZIP layout. Use the API instead (option A). |

Version pinning: use the STruC++ version the current Editor pins (`binary-versions.json` → v0.7.0) for runtime v4.3.0. The runtime keeps an ABI mirror (`core/src/lib/strucpp_abi.hpp`), so a much newer or older STruC++ may break.

---

## 4. Modbus / I-O

### 4.1 v4 Modbus master: OpenPLC polls Factory I/O (recommended)

The ZIP entry `conf/modbus_master.json` enables the plugin, which copies it to `core/src/drivers/plugins/python/modbus_master/`. Schema per `plugin_config_decode/modbus_master_config_model.py` and the Editor's `generate-modbus-master-config.ts`. **[RUN]**

```json
[
  {
    "name": "factoryio",
    "protocol": "MODBUS",
    "config": {
      "type": "SLAVE",
      "transport": "tcp",
      "host": "<Factory I/O Windows private IP>",
      "port": 502,
      "timeout_ms": 1000,
      "slave_id": 1,
      "io_points": [
        { "fc": 2,  "offset": "0x0000", "iec_location": "%IX100.0", "len": 6, "cycle_time_ms": 50,  "error_handling": "set-to-zero" },
        { "fc": 15, "offset": "0x0000", "iec_location": "%QX100.0", "len": 4, "cycle_time_ms": 50,  "error_handling": "keep-last-value" },
        { "fc": 16, "offset": "0x0000", "iec_location": "%QW100",   "len": 1, "cycle_time_ms": 100, "error_handling": "keep-last-value" }
      ]
    }
  }
]
```

Function codes:

- **Reads into the PLC:** `fc` 1 (coils), 2 (discrete inputs), 3 (holding registers), 4 (input registers).
- **Writes from the PLC:** `fc` 5 (single coil), 6 (single register), 15 (multiple coils), 16 (multiple registers).

Fields:

- `offset` is the 0-based Modbus address, as a decimal string or `0x..` hex string.
- `len` is the number of coils or registers. Consecutive IEC addresses are filled starting at `iec_location`, so `%IX100.0` with `len` 6 covers `%IX100.0..%IX100.5`.
- Valid IEC areas:
  - bits: `%IX` (input buffer) and `%QX` (output buffer); `%MX` is **not** supported for bits;
  - words: `%IW`, `%QW`, `%MW` (and B/D/L sizes).
  - The usual pairing is reads → `%IX`/`%IW` and writes ← `%QX`/`%QW`.
- Address math:
  - bit: byte = `index/8`, bit = `index%8`;
  - `%IWn` = `int_input[n]`.
- Polling uses one thread per device. The base tick is the GCD of the `cycle_time_ms` values.
- `error_handling` is `keep-last-value` (default) or `set-to-zero`, applied to read points while communication is down.
- Several devices may share host:port if their `slave_id`s differ.

Runtime caveats [RUN]:

- The plugin needs `./venvs/modbus_master` with `pymodbus==3.11.2`. It must be built with the **same Python minor version as `libpython` in `plc_main`**. `start_openplc.sh` and the Docker image create it automatically.
- A plugin that failed to import is not retried until `plc_main` restarts.
- After the plugin's start, communication with a freshly started server took about 2–4 s to establish.

### 4.2 v4 Modbus slave: OpenPLC as server (optional, for monitoring)

The ZIP entry `conf/modbus_slave.json` (`generate-modbus-slave-config.ts`, `simple_modbus.py`) **[SRC]**:

```json
{ "network_configuration": { "host": "0.0.0.0", "port": 502 },
  "buffer_mapping": {
    "holding_registers": { "qw_count": 1024, "mw_count": 1024, "md_count": 1024, "ml_count": 1024 },
    "coils": { "qx_bits": 8192, "mx_bits": 0 },
    "discrete_inputs": { "ix_bits": 8192 },
    "input_registers": { "iw_count": 1024 } } }
```

Register map, identical to v3's built-in slave:

| Modbus table | Addresses | IEC area | Access from a client |
|---|---|---|---|
| Coils | `n` | `%QX(n/8).(n%8)`, so `%QX100.0` is coil 800 | read/write |
| Discrete inputs | `n` | `%IX(n/8).(n%8)` | **read-only** |
| Input registers | `n` | `%IWn` | **read-only** |
| Holding registers | 0–1023 | `%QW0–1023` | read/write |
| Holding registers | 1024–2047 | `%MW0–1023` | read/write |
| Holding registers | 2048–4095 | `%MD` (2 regs each) | read/write |
| Holding registers | 4096–8191 | `%ML` (4 regs each) | read/write |

Because discrete inputs and input registers are read-only to clients, **Factory I/O as a client could not write sensor values into `%IX`/`%IW`.** That is why "OpenPLC = Modbus master, Factory I/O = Modbus server" is the right topology. Use the slave plugin only so that our agent can read PLC state, e.g. coil 800 = `%QX100.0`.

### 4.3 v3 conventions [SRC]

**Slave Devices** (OpenPLC v3 acts as master; `core/modbus_master.cpp`, `MAX_MB_IO` 400 per type, summed over all devices in table order):

| Device table | Function code | IEC range |
|---|---|---|
| Discrete inputs | FC2 | `%IX100.0` onward |
| Coils | FC15 | written from `%QX100.0` onward |
| Input registers, then holding-read registers | FC4, FC3 | `%IW100` onward |
| Holding registers (write) | FC16 | written from `%QW100` onward |

- Polling period: Settings `Slave_polling` (default 100 ms). Timeout: `Slave_timeout` (default 1000 ms).
- `%IX0.0–%IX99.7` and `%QX0.0–%QX99.7` are reserved for the local hardware layer, which is blank on a generic Linux VM.

**Built-in Modbus server:** port 502 by default (Settings `Modbus_port`), with the same map as the §4.2 table.

**glue_generator** binds `%IX %QX %IB %QB %IW %QW %ID %QD %MW %MD %ML`.

- `%MX`/`%MB` are silently unbound.
- A bit index ≥ 8 only prints a warning and writes out of bounds.
- `%QL` is mis-bound to `lint_input` (bug).

### 4.4 Factory I/O driver [UNVERIFIED]

Source: search snippets of `docs.factoryio.com/manual/drivers/modbus-server/`. The page itself is blocked from this sandbox.

- Use the **"Modbus TCP/IP Server"** driver. Factory I/O is then the slave. Default port 502.
- The host IP is the selected network adapter, shown read-only in the driver.
- Settings:
  - **Write Digital** (sensors) = `Inputs` (discrete inputs) or `Coils`;
  - **Read Digital** (actuators) = `Coils` or `Inputs`;
  - **Write Register** / **Read Register** choose Input Registers vs Holding Registers.
- Each group (Digital Inputs, Digital Outputs, Register Inputs, Register Outputs) has an **offset** and a **count**. Digital groups go up to 256; register groups up to 64.
- Use offset 0 everywhere, and assign scene tags to points in order.
- Allow inbound TCP 502 in the Windows Firewall. Factory I/O only serves while the driver is connected and the scene is running.

### 4.5 Recommended mapping: one ST file for both v3 and v4

| Factory I/O point (driver index n) | Modbus at Factory I/O | v4 `io_points` entry | ST declaration | v3 Slave Device row |
|---|---|---|---|---|
| Digital sensor n | Discrete input n (FC2) | `{fc:2, offset:"0x0000", iec_location:"%IX100.0", len:N}` | `x AT %IX(100+n/8).(n%8) : BOOL;` | DI start 0, size N |
| Digital actuator n | Coil n (FC15) | `{fc:15, offset:"0x0000", iec_location:"%QX100.0", len:M}` | `y AT %QX(100+n/8).(n%8) : BOOL;` | Coils start 0, size M |
| Register sensor n | Input register n (FC4) | `{fc:4, offset:"0x0000", iec_location:"%IW100", len:K}` | `a AT %IW(100+n) : INT;` (or `UINT`/`WORD`) | IR start 0, size K |
| Register actuator n | Holding register n (FC16) | `{fc:16, offset:"0x0000", iec_location:"%QW100", len:L}` | `b AT %QW(100+n) : INT;` | HR-write start 0, size L |

Why offset 100:

- It matches v3's fixed slave-device window.
- It is legal in v4, where `iec_location` is free-form and the buffers hold 1024 entries.
- So the same ST runs on both runtimes, and the v4 `iec_location`s are simply set to 100.

Verified data path [RUN] (`fake_factoryio_server.py` → `fake_factoryio_run.log`):

- Discrete inputs 0..5 reached `%IX100.0..5`.
- `%QX100.0..3` were written to coils 0..3.
- `%QW100` (CTU count) was written to holding register 0. The value read 3 after three parts.
- With `error_handling:"set-to-zero"`, the NC e-stop read FALSE while the link was down. The fault latch therefore tripped and needed a reset after Factory I/O connected. This is the correct fail-safe behaviour; the agent should pulse reset after connecting.

### 4.6 AWS networking checklist [UNVERIFIED]

- **Runtime instance:** inbound 8443/tcp from the agent only. Add 502/tcp only if `modbus_slave` is enabled. With the one-liner the runtime uses host networking; with plain `docker run` you need `-p`.
- **Windows Factory I/O instance:** inbound 502/tcp from the runtime instance's private IP, in both the security group and Windows Defender Firewall. Put the private IP in `modbus_master.json` `host`.
- **Outbound:** the runtime connects out to Windows:502. The Modbus master needs no inbound rule on the runtime.

---

## 5. OpenPLC v3 fallback (thiagoralves/OpenPLC_v3 master)

### 5.1 Processes and ports [SRC]

- `webserver/webserver.py` runs two Flask apps in threads:
  - **HTTP :8080** legacy web UI (Flask-Login session cookie; default user `openplc` / `openplc` in `openplc.db`);
  - **HTTPS :8443** REST API (JWT; separate `restapi.db` users; self-signed `certOPENPLC.pem`).
- The runtime is `core/openplc`, rebuilt at every compile and controlled over TCP `localhost:43628`.
- Defaults (`Settings`):

  | Key | Default |
  |---|---|
  | `Modbus_port` | 502 (enabled) |
  | `Dnp3_port` | disabled |
  | `Enip_port` | 44818 |
  | `Start_run_mode` | false |
  | `Slave_polling` | 100 |
  | `Slave_timeout` | 1000 |
  | `snap7` | true |

- Install: `./install.sh linux` (builds matiec, `st_optimizer`, `glue_generator`, libmodbus, snap7, dnp3), then `./start_openplc.sh`, or a systemd unit. The repo `Dockerfile` (`debian:trixie`, `./install.sh docker`) has no published image.
- Detect v3 vs v4:
  - `GET /api/version` returns 200 only on v4. On v3 it falls into the JWT catch-all and returns 401.
  - Every v3 `/api` response carries `X-OpenPLC-Runtime-Version: v3`.

### 5.2 v3 REST API sequence (:8443, what the v4 Editor uses) [SRC]

```
POST /api/create-user {"username","password"}     (only unauthenticated while restapi.db is empty; else 401 {"msg":"User already created!"})
POST /api/login {"username","password"}           -> {"access_token": "..."}   (15 min, same library default)
POST /api/upload-file  multipart file=@program.st (text/plain) (Bearer)
     -> {"UploadFileFail":"","CompilationStatus":"COMPILING"}  (saved as st_files/webserver_program.st; runtime stopped; compile started)
     -> {"UploadFileFail":"Runtime is compiling another program, please wait","CompilationStatus":"COMPILING"}
GET  /api/compilation-status -> {"status":"COMPILING"|"SUCCESS"|"FAILED","logs":[lines],"exit_code":0|1}
     (SUCCESS iff logs contain "Compilation finished successfully!"; FAILED iff "Compilation finished with errors!";
      NOTE: returns COMPILING when nothing was ever compiled -- only poll after an upload)
GET  /api/start-plc   -> {"status":"START:OK"} (always; also (re)starts Modbus/DNP3/ENIP per Settings)
GET  /api/stop-plc    -> {"status":"STOP:OK"}
GET  /api/status      -> {"status":"STATUS:RUNNING"|"STATUS:STOPPED"|"STATUS:EMPTY"(compiling)|"STATUS:UNKNOWN"}
GET  /api/runtime-logs -> {"runtime-logs":"<one string>"}   (string, not a list like v4)
GET  /api/ping        -> {"status":"PING:OK"}
Other: GET /api/get-users-info, GET /api/get-user-info/<id>, PUT /api/password-change/<id>, DELETE /api/delete-user/<id>, POST /api/logout
```

The REST API cannot configure Slave Devices or Settings. Use the web UI (§5.3) once, during provisioning.

### 5.3 v3 legacy web UI scripted sequence (:8080, use a cookie jar) [SRC]

1. `POST /login`, form fields `username`, `password`. Success returns 302 to `/dashboard` with a `session` cookie. Failure returns 200 with the login page.
2. `POST /upload-program`, multipart field `file` (the .st). The HTML response contains `<input type='hidden' value='NNNNNN.st' id='prog_file' name='prog_file'/>` and `name='epoch_time'`. Parse both; the file name is random.
3. `POST /upload-program-action`, form fields `prog_name` (non-empty), `prog_descr`, `prog_file=NNNNNN.st`, `epoch_time=<int unix time>`. This inserts a `Programs` row and returns a meta-refresh to `/compile-program?file=NNNNNN.st`.
4. `GET /compile-program?file=NNNNNN.st` starts compilation (and stops the PLC if running).
   - `GET /reload-program?table_id=<Prog_ID>` only shows the info page.
   - Its "Launch program" link is `compile-program?file=...`.
5. Poll `GET /compilation-logs` (plain text, cumulative) until it contains `Compilation finished successfully!` or `Compilation finished with errors!`.
6. `GET /start_plc` returns 302 to the dashboard. `GET /stop_plc` likewise.
   - `GET /runtime_logs` returns text.
   - Status appears only in the dashboard HTML ("Running"/"Stopped"/"Compiling").
7. **Slave device** (Factory I/O): `POST /add-modbus-device`, form fields:
   - `device_name`, `device_protocol` = `TCP` (or `ESP32`, `ESP8266`, `RTU`), `device_id` (slave id), `device_ip`, `device_port` (502);
   - `device_cport`, `device_baud`, `device_parity`, `device_data`, `device_stop`, `device_pause` (RTU only, but send them empty);
   - `di_start`, `di_size`, `do_start`, `do_size` (coils), `ai_start`, `ai_size` (input registers);
   - `aor_start`, `aor_size` (holding read), `aow_start`, `aow_size` (holding write).

   The server regenerates `mbconfig.cfg`; the change takes effect on the next PLC start. Mapping: §4.3. Edit with `POST /modbus-edit-device`, delete with `GET /delete-device?dev_id=N`.
8. **Settings:** `POST /settings`, fields `modbus_server_port`, `dnp3_server_port`, `enip_server_port`, `pstorage_thread_poll`, `auto_run_text`, `snap7_run_text`, `slave_polling_period`, `slave_timeout`, `device_hostname`.
   - **An omitted port field disables that service.**
   - `device_hostname` **must equal the current hostname**; otherwise the server runs `hostnamectl set-hostname`.
   - `auto_run_text=true` makes the PLC start at boot.
9. **Monitoring:** `GET /monitor-update?mb_port=502` returns an HTML table of the located variables of the active program, read through the local Modbus server. `GET /point-write?value=1&address=%QX100.0` forces a value.

### 5.4 v3 `.st` format and compile [SRC + RUN for iec2c/g++ steps]

`scripts/compile_program.sh <file>` runs from `webserver/`:

```bash
./iec2c -f -l -p -r -R -a ./st_files/<file>     # cwd has lib/ (ieclib.txt etc.)
mv -f POUS.c POUS.h LOCATED_VARIABLES.h VARIABLES.csv Config0.c Config0.h Res0.c ./core/   # names are case-sensitive!
cd core && g++ -std=gnu++11 -I ./lib -c Config0.c -w && g++ -std=gnu++11 -I ./lib -c Res0.c -w
./glue_generator && g++ -std=gnu++11 *.cpp *.o -o openplc -I ./lib -pthread -fpermissive `pkg-config --cflags --libs libmodbus` -lsnap7 ... -w
echo "Compilation finished successfully!"   # or "Compilation finished with errors!"
```

A minimal accepted file is `research/openplc_samples/conveyor.st`. Lines starting `(*DBG:` and `(*FILE:` are special Editor sections; plain ST without them uses `core/debug.blank`.

---

## 6. matiec (iec2c) local preflight and dialect constraints

### 6.1 Build [RUN]

The build took 26 s.

```bash
apt-get update && apt-get install -y flex          # bison/autoconf/automake/g++ were present
cp -a refs/OpenPLC_v3/utils/matiec_src/. refs/matiec-build/ && cd refs/matiec-build
autoreconf -i && ./configure && make -j"$(nproc)"
```

| What | Path |
|---|---|
| **iec2c binary** | `$SCRATCH/refs/matiec-build/iec2c` (`iec2iec` is also built) |
| ST standard library (`-I`) | `$SCRATCH/refs/OpenPLC_v3/webserver/lib` (v3 parity: `ieclib.txt` plus OpenPLC blocks). Pristine matiec alternative: `$SCRATCH/refs/matiec-build/lib`. Default lookup is `./lib` relative to cwd. |
| C headers for the g++ step | `$SCRATCH/refs/OpenPLC_v3/webserver/core/lib` (v3 parity) or `$SCRATCH/refs/matiec-build/lib/C` |
| Wrapper | `research/openplc_samples/preflight_matiec.sh <file.st> [outdir]`. Runs iec2c, checks the v3 output file names, then runs `g++ -c Config0.c Res0.c`. Exit 0 ok, 1 iec2c error, 2 g++ error, 3 missing Config0/Res0 files. |

### 6.2 Exact command and output for the sample [RUN]

```
$ iec2c -f -l -p -r -R -a -I $SCRATCH/refs/OpenPLC_v3/webserver/lib -T <out> conveyor.st
POUS.c
POUS.h
LOCATED_VARIABLES.h
VARIABLES.csv
Config0.c
Config0.h
Res0.c
$ g++ -std=gnu++11 -I $SCRATCH/refs/OpenPLC_v3/webserver/core/lib -c Config0.c -w   -> ok
$ g++ -std=gnu++11 -I $SCRATCH/refs/OpenPLC_v3/webserver/core/lib -c Res0.c -w      -> ok
LOCATED_VARIABLES.h: __LOCATED_VAR(BOOL,__IX100_0,I,X,100,0) ... __LOCATED_VAR(INT,__QW100,Q,W,100)
Config0.c: common_ticktime__ = 20000000ULL (from TASK INTERVAL T#20ms)
```

Logs are in `openplc_samples/iec2c_conveyor_output.txt`.

The same sample through STruC++ and the real v4.3.0 runtime gave `PASS` → `SUCCESS` → `RUNNING` (§2.9).

**Error format.** iec2c writes `<file>:<line>-<col>..<line>-<col>: error: <msg>` per error, then `N error(s) found. Bailing out!` and exits 1. A crash gives exit 139.

STruC++ errors look like `<file>:<line>:<col>: error: <msg>` plus a caret excerpt and an optional `note:`.

### 6.3 Dialect matrix (46 probes in `openplc_samples/dialect_tests/`) [RUN]

| # | Construct | matiec / v3 | STruC++ / v4 |
|---|---|---|---|
| sample | Located and plain variables **in the same `VAR` block** | **FAIL** `invalid located variable declaration` (cascades to bogus statement errors) | pass |
| t01 | `//` line comment | **FAIL** | pass |
| t02 | `/* */` comment | **FAIL** | **FAIL** |
| t03 | nested `(* (* *) *)` | **FAIL** (v3 does not pass `-n`) | pass |
| t04 | lowercase `configuration config0`/`resource res0` | iec2c ok, but writes `config0.c`/`res0.c`, so the v3 `mv Config0.c` **fails** | pass |
| t05/t26 | no CONFIGURATION, or not named `Config0` | v3 fails (no `Config0.c`) | STruC++ passes, but **the runtime g++ fails** (`Configuration_CONFIG0` missing) |
| t06 | undeclared variable | FAIL `Ambiguous enumerate value or Variable not declared in this scope.` | FAIL `Undeclared variable 'B'` |
| t07 | `BOOL := INT` | **FAIL** `Incompatible data types for ':=' operation.` | pass (lenient) |
| t08 | missing `;` before `END_PROGRAM` | FAIL with misleading `invalid IL instruction` | FAIL |
| t09 | TON TOF TP R_TRIG F_TRIG SR RS CTU CTD CTUD; MAX MIN LIMIT ABS SEL MUX SQRT SHL; `*_TO_*` conversions; TIME arithmetic | pass | pass |
| t10 | assigning to an `%IX` variable | pass (overwritten each scan) | pass |
| t11 | `VAR_GLOBAL` with AT in CONFIGURATION + `VAR_EXTERNAL` | pass | pass |
| t12 | identifiers `ON`, `TIME` | **FAIL** (reserved) | pass |
| t13 | `T#5s TIME#5s t#1m30s T#1.5s T#500MS T#1h2m3s4ms` | pass | pass |
| t14 | `%MW0 %MD0 %IW100 %QW100 %IB0` | pass | pass |
| t15 | `%IX0.8` (bit > 7) | **pass silently** (glue writes out of bounds) | FAIL `Bit index 8 out of range` |
| t16 | assigning to `VAR CONSTANT` | FAIL | FAIL |
| t17 | user FUNCTION / FUNCTION_BLOCK, named and positional calls | pass | pass |
| t18 | `REAL := INT * 2.5` | **FAIL** `Data type mismatch for '*'` → use `INT_TO_REAL(i) * 2.5` | pass |
| t19 | `ELSEIF` | FAIL (must be `ELSIF`) | FAIL |
| t20 | FOR/WHILE/REPEAT/CASE (ranges), ARRAY, STRING, CONCAT, LEN | pass | pass |
| t21 | positional FB call `t1(a, T#1s)` | pass | pass (avoid; use named) |
| t22 | `IF a := b` | FAIL | FAIL |
| t23 | 2 programs / 2 tasks | pass | pass |
| t24 | located variable with initial value | pass | pass |
| t25 | same `%QX100.0` twice | FAIL | FAIL `Duplicate address` |
| t27 | `END_IF` without `;` | **FAIL** | pass |
| t28 | `True`/`false`, `BOOL_TO_INT` | pass | pass |
| t29 | variables named `IN`, `Q`; instance `TON1` | pass | pass |
| t30 | resource without TASK | **FAIL** `You must define at least one periodic task` | pass |
| t31 | `INT#5 16#0F 2#1010 8#17 WORD#16#FFFF` | pass | pass |
| t32 | `rt(CLK:=x).Q` inline | FAIL | FAIL |
| t33 | bit access `w.0` | **FAIL** | pass |
| t34 | `%IX100.0` used directly in code | FAIL | FAIL (declare `AT` variables) |
| t35 | `a, b, c : BOOL;` | pass | pass |
| t36 | `INT := 40000` | **FAIL** | pass (silently overflows) |
| t37 | `**` operator | iec2c ok but **v3 g++ FAIL** (`__expt` undeclared in v3 headers) | pass |
| t46 | `EXPT(2.0, 3.0)` | pass | pass |
| t38 | `TYPE` enum + STRUCT | pass | pass |
| t39 | `VAR RETAIN` | pass | pass |
| t40 | `"double quoted"` into STRING | FAIL (WSTRING) | FAIL |
| t42 | empty statement `;` | **FAIL** | pass |
| t43 | AT in `VAR_OUTPUT` of a PROGRAM | FAIL | FAIL (clear message) |
| t44 | AT inside FUNCTION_BLOCK | FAIL and **iec2c segfaults (exit 139)** | FAIL |
| t45 | `REAL > 80` (INT literal) | **FAIL** → write `80.0` | pass |

### 6.4 Edge-trigger semantics differ [SRC]

- **v3** `lib/edge_detection.txt`: `F_TRIG` has `M` initialised FALSE, so it **pulses on the first scan when CLK starts FALSE**.
- **STruC++**: `F_TRIG` initialises `M := TRUE`, so there is no first-scan pulse.
- In both, `R_TRIG` pulses on the first scan if CLK starts TRUE.
- In v4 the edge memories are `RETAIN`. The runtime logs "17 bytes of retained variables" but keeps them only if persistent storage is configured.

### 6.5 Rules for the generator (intersection of the two dialects)

1. Comments only `(* ... *)`, not nested. No `//` and no `/* */`.
2. **Put located variables (`AT %...`) in their own `VAR ... END_VAR` block, inside a PROGRAM** (or in CONFIGURATION `VAR_GLOBAL`). Never in VAR_INPUT/VAR_OUTPUT, never in a FUNCTION_BLOCK, never mixed with plain variables.
3. Always end with exactly:
   ```
   CONFIGURATION Config0
     RESOURCE Res0 ON PLC
       TASK task0(INTERVAL := T#20ms,PRIORITY := 0);
       PROGRAM instance0 WITH task0 : <program_name>;
     END_RESOURCE
   END_CONFIGURATION
   ```
   Spell it with this exact case, because v3 renames files case-sensitively.
4. Every statement ends with `;`, including `END_IF;`, `END_CASE;`, `END_FOR;` and the last statement before `END_PROGRAM`. No empty statements.
5. Use strict typing:
   - explicit conversions (`INT_TO_REAL`, `BOOL_TO_INT`, `DINT_TO_INT`, ...);
   - REAL literals with a decimal point (`80.0`);
   - INT literals within −32768..32767;
   - `EXPT()` instead of `**`.
6. Use `ELSIF`, not `ELSEIF`. Strings take single quotes. Never use reserved words as identifiers (`ON`, `TIME`, `TASK`, `AT`, ...).
7. Call FBs as statements with named parameters (`t(IN := x, PT := T#5s);`), then read `t.Q` / `t.ET`. No inline `fb(...).Q`.
8. Bit index 0..7. No duplicate addresses. No `%IX..` literals in expressions. No bit access `w.0`.
9. Use `%IX100.x`/`%QX100.x`/`%IW100+`/`%QW100+` for Factory I/O points (§4.5), and `%MW` for internal values the agent may want to read through the Modbus slave.
10. Don't rely on the first-scan behaviour of `F_TRIG`, which differs between runtimes.
11. Preflight: `preflight_matiec.sh` (strict) **and** `preflight_v4.sh` (STruC++ plus the exact g++ steps the runtime runs). Feed the `error:` lines back to the LLM.

---

## 7. Recommended MongoMation pipeline

1. The LLM generates ST following the §6.5 rules and the §4.5 address map.
2. `preflight_matiec.sh conveyor.st` (catches strictness issues, about 0.2 s).
3. `preflight_v4.sh conveyor.st out/ modbus_master.factoryio.json` (about 4 s). It produces `out/program.zip` and fails on any STruC++ or g++ error, catching what would otherwise wipe the device program.
4. `deploy_v4.py --host <runtime> --user .. --password .. --zip out/program.zip --cafile certOPENPLC.pem [--create-user]`. On `FAILED`, re-upload the last good ZIP.
5. Verify:
   - read Factory I/O state, or enable `conf/modbus_slave.json` and read `%QX100.x` as coils `800+x`;
   - check `/api/runtime-logs` for `[MODBUS_MASTER]` connection errors;
   - check `/api/status?include_stats=true` for `overruns`.

v3 path: run step 2 only, then do the §5.2 REST sequence with `program.st`, or the §5.3 web-UI sequence.

---

## 8. Files produced

All paths are relative to `$SCRATCH/research/openplc_samples/`.

**ST samples:**

| File | Description |
|---|---|
| `conveyor.st` | Verified sample: TON jam timer, three R_TRIGs, fault latch, CTU, `%IX100.0..5`, `%QX100.0..3`, `%QW100` |
| `bad_mixed_located_and_plain_in_one_VAR.st` | Example of the main matiec failure |
| `dialect_tests/t01..t46*.st` | Dialect probes |

**Scripts:**

| File | Description |
|---|---|
| `preflight_matiec.sh` | iec2c + v3 g++ preflight |
| `build_v4_bundle.mjs` | STruC++ → v4 bundle + `program.zip` (Editor-equivalent) |
| `strucpp_check.mjs` | STruC++ syntax/semantic check of N files |
| `preflight_v4.sh` | STruC++ + runtime-identical g++ build → `program.zip` |
| `deploy_v4.py` | stdlib-only v4 deploy client (verified) |
| `fake_factoryio_server.py` | pymodbus stand-in for the Factory I/O server, with a conveyor test scenario |

**Modbus configs:**

| File | Description |
|---|---|
| `modbus_master.factoryio.json` | Template; replace `FACTORY_IO_WINDOWS_PRIVATE_IP` |
| `modbus_master.factoryio.local-test.json` | Version used in the local test (127.0.0.1:5020) |

**Logs:**

| File | Description |
|---|---|
| `iec2c_conveyor_output.txt` | iec2c run on the sample |
| `iec2c_bad_example_output.txt` | iec2c run on the bad example |
| `dialect_tests_results.log`, `dialect_tests_results_2.log` | matiec results |
| `strucpp_dialect_results.log` | STruC++ results |
| `fake_factoryio_run.log` | Verified Modbus I/O scenario |

**Built bundles:** `v4_conveyor*/program.zip`.

**Toolchains:**

| What | Path |
|---|---|
| matiec | `$SCRATCH/refs/matiec-build/iec2c` |
| STruC++ 0.7.0 | `$SCRATCH/refs/strucpp-run/node_modules/strucpp` (tgz in `$SCRATCH/refs/strucpp-release/`) |
| Locally built runtime v4.3.0 | `$SCRATCH/refs/openplc-runtime-build`. Start from that directory as root with `OPENPLC_PERSISTENT_DATA_DIR=$SCRATCH/v4data venvs/runtime/bin/python3 -m webserver.app`. Local test user: `mongo` / `mation-pass`. It is currently stopped. |

## 9. Not verified / open items

- OpenPLC v3 was **not** run here, so §5 is source reading only. In particular, the HTML parsing of `prog_file` and `epoch_time` and the v3 REST behaviour need a smoke test on the real instance.
- Factory I/O driver option names and defaults (§4.4) come from search snippets; docs.factoryio.com was blocked here. Confirm in the UI:
  - Write Digital = Inputs;
  - Read Digital = Coils;
  - offsets 0;
  - whether a slave ID is configurable.
- The official ghcr Docker image was not pulled (sandbox egress block). Behaviour should match the source build used here (same commit and VERSION).
- The Windows (MSYS2) runtime build and the `openplc-cli` path were not tested.
- The exact `"Token has expired"` message text was not observed; it is the library default.
- The debug Socket.IO PDU layout (`docs/DEBUG_PROTOCOL.md`) may be stale versus the STruC++ debug-map indices. Prefer the Modbus slave for state readback.
