# OpenPLC samples and helper scripts (from the prep research)

| File | What |
|---|---|
| `conveyor.st` | sample that passes MatIEC, STruC++ **and** ran on a real OpenPLC v4.3.0 runtime (TON jam timer, R_TRIG, fault latch, CTU) |
| `preflight_matiec.sh` | v3-style preflight: `iec2c` + `g++ -c Config0.c Res0.c` (env: `IEC2C`, `IEC_LIB`, `C_LIB`) |
| `preflight_v4.sh` | v4 preflight: STruC++ + the exact g++ steps the runtime runs; produces `program.zip` |
| `build_v4_bundle.mjs` | STruC++ → runtime v4 bundle (mirrors the Editor); env `STRUCPP_DIR` |
| `deploy_v4.py` | stdlib-only v4 deploy client with certificate pinning |
| `modbus_master.factoryio.json` | verified v4 Modbus master plugin config template (replace the host) |
| `dialect_tests/` | 46 dialect probes; results summarized in `../openplc.md` §6.3 |

Default tool paths point at `$MM_TOOLS` (default `~/mm-tools`); override with the env vars above.
The worker itself does the same work in TypeScript (`apps/worker/src/tools/preflight.ts`, `openplc.ts`).
