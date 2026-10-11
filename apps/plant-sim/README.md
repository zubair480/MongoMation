# plant-sim

This service is a software-in-the-loop plant for Factory I/O "Sorting by Height (Basic)". It runs closed-loop with the real OpenPLC over Modbus TCP:
- It reads the PLC outputs every ~50 ms.
- It moves the boxes on the server at a 20 ms tick.
- It writes the sensor coils back to the PLC, but only while the user has armed it.

It streams state on `ws://localhost:5195` and serves `GET /health`. The contract is `prototype/ui-redesign/PLANT_SIM_CONTRACT.md`.

## Run

```bash
cd /home/zubair/mongomation/apps/plant-sim
source ~/.nvm/nvm.sh && npm install   # first time only
npm start                              # ws://localhost:5195, READ-ONLY until armed from the UI
```

The OpenPLC Modbus port (:502) is not exposed on the internet. Reach it through the documented SSM port-forward (rig kit `docs/ENDPOINTS.md` §2), which maps it to `localhost:5020`. That is the service's default:

```bash
aws ssm start-session --region us-west-2 --target <RIG_INSTANCE> \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=502,localPortNumber=5020
```

| env | default | meaning |
|---|---|---|
| `PLC_MODBUS_HOST` / `PLC_MODBUS_PORT` / `PLC_MODBUS_UNIT` | `127.0.0.1` / `5020` / `1` | OpenPLC Modbus server |
| `PLANT_SIM_PORT` | `5195` | WebSocket + /health |
| `HEIGHT_GATE_X` | `-1.7` | x position of the Low/High sensors (see below) |
| `BELT_SPEED`, `EMIT_EVERY_S` | `1.5`, `3` | physics |
| `PLANT_SIM_AUTO` | unset | `1` holds the Auto selector TRUE while armed |

## I/O (verified map: rig kit `config/io_mapping.json`)

- **Writes**: coils 100..113 only (`%QX12.4`..`%QX14.1`), and only while armed.
  - Coil 113 "FACTORY I/O (Running)" is driven TRUE while armed, because the sorter programs halt every actuator without it.
- **Reads**: output coils 0..9, holding registers 0..4 (Counter, then the sorter's state, tall, short and fault diagnostics), and input coils 100..113.
- The service never writes output coils and never uploads programs.

## Safety

The service starts read-only. A disarmed plant still mirrors the real PLC outputs. An `arm` is refused in each of these cases:
- the Modbus link is down
- Atlas (read-only; URI from `.env` `MONGODB_URI_WEB`, never printed) has a `jobs` doc that is `running` or `verifying`
- the latest fresh `rig_status` says the Factory I/O scene is running
- coil 113 is already TRUE, which means Factory I/O is still connected to the PLC

**Stop the Factory I/O scene before arming.**

While armed, the service disarms by itself in these cases:
- the Atlas check fails, or a job starts
- the link drops
- the read-back of coils 100..113 keeps disagreeing with what it wrote, which means another writer such as Factory I/O has reconnected

On disarm, and on SIGINT/SIGTERM while armed, it writes the rest state: Stop=TRUE, E-stop=TRUE, retro eyes TRUE (clear), everything else FALSE (including coil 113).

## Height gate position

The real `sorter_v1.st` measures height only while **Pallet sensor AND Low sensor** are both TRUE, with the box resting at the end-stop. So the real scene has the height sensors beside the pallet sensor. That is why `HEIGHT_GATE_X` defaults to `-1.7` instead of the contract's `-4`. With `-4`, a single box never trips both sensors, and the real program waits in state 1 forever. The value is published in every state message as `geometry.heightGateX`.

## Tests (local mock only, never the real PLC)

```bash
node test/closed-loop.test.js 60   # mock PLC (JS port of sorter_v1) on :5021 + sim on :5196, arms, sorts, disarms
node test/watch.js 5               # read-only client: rate + one sample from ws://localhost:5195
```

`test/mock-plc.js` exposes the marker `HR1000..1001 = "MKOC"`. The Atlas guard is skipped only when `PLANT_SIM_MOCK=1`, the host is loopback, and that marker is present.

## Protocol extras

Beyond the contract, the state message also carries `plcInputs` (what the PLC holds in coils 100..113), `diag`, `sorted`, `estopLatched`, `mock`, `atlas` and `geometry`.
