# Setup

How to run MongoMation end to end: Atlas + Claude + Raindrop (+ the Modelence dashboard), the engineering worker, and
the AWS rig (OpenPLC Runtime v4 + Factory I/O). Every command runs in **WSL (Ubuntu)** at the repo root unless noted.

> Private values (AWS account, EC2 instance id, the DCV address, passwords) are in the private rig handoff
> (`ENDPOINTS.md`), never in this repo. Do not paste them into tracked files.

## 1. Node + dependencies

```bash
# Node >= 22.13 (nvm recommended)
source ~/.nvm/nvm.sh && nvm use 22
npm ci                      # or npm install
npm test && npm run typecheck && npm run verify:isolation
cp .env.example .env        # then fill in the blanks (see .env.example comments)
```

`npm ci` wipes STruC++ (it is not in `package.json`), so re-run §4 after every `npm ci`.

## 2. Atlas, Claude, Raindrop

1. Fill `MONGODB_URI` (worker user), `MONGODB_URI_WEB` (dashboard user), `ANTHROPIC_API_KEY`, `RAINDROP_WRITE_KEY` in `.env`.
2. Make sure your current IP is in Atlas → Network Access.
3. Create collections/indexes and seed harness v0 + the scene registry:

```bash
npm run setup:atlas
npm run seed                # the scene must report VERIFIED, otherwise validation is BLOCKED
npm run green               # ✓ atlas ✓ claude ✓ raindrop – preflight ✓ openplc ✓ factoryio
```

`npm run green` makes a real call for each row. The `openplc` / `factoryio` rows stay red until §5–§6 are done.

### 2.1 Least-privilege database users (two users, not one)

| User (URI var) | Role | Why |
|---|---|---|
| worker (`MONGODB_URI`) | built-in `readWrite@mongomation` | writes all engineering state; runs the RSI transactions (`rsi/evolve.ts`) and the `jobs` change stream (`harness/jobwatch.ts`) |
| dashboard (`MONGODB_URI_WEB`) | custom `mm_web` | reads everything, can only **insert** into `jobs` (buttons enqueue work); cannot update or delete anything |

`mm_web` = inherited `read@mongomation` + one extra privilege:

```json
{
  "roleName": "mm_web",
  "inheritedRoles": [{ "role": "read", "db": "mongomation" }],
  "actions": [{ "action": "INSERT", "resources": [{ "db": "mongomation", "collection": "jobs" }] }]
}
```

Create it (Atlas UI: Database Access → Custom Roles → Add: Built-in Role `read` on `mongomation`, Collection action
`insert` on `mongomation.jobs`; then Database Users → edit the dashboard user → Custom Role `mm_web`, remove other
roles). Or with the Atlas CLI:

```bash
atlas customDbRoles create mm_web --inheritedRole read@mongomation --privilege INSERT@mongomation.jobs
atlas dbusers update <dashboard-user> --role mm_web@admin
```

Check without writing anything: `mongosh "$MONGODB_URI_WEB" --eval 'db.runCommand({connectionStatus: 1, showPrivileges: true}).authInfo.authenticatedUserPrivileges'`
lists `find`/`changeStream`/... on `mongomation` and `insert` only on `mongomation.jobs`.

## 3. Local preflight compiler (MatIEC `iec2c`, optional)

The worker can syntax-check ST locally before it touches the shared rig. Without it the preflight row reports
`unavailable` (never counted as a pass) and the authoritative compile happens on OpenPLC.

```bash
git clone https://github.com/thiagoralves/OpenPLC_v3 ~/OpenPLC_v3     # if not already present
cd ~/OpenPLC_v3/utils/matiec_src && autoreconf -i && ./configure && make
```

Then in `.env`: `IEC2C_PATH=$HOME/OpenPLC_v3/utils/matiec_src/iec2c`, `IEC_LIB=$HOME/OpenPLC_v3/utils/matiec_src/lib`,
and optionally `OPENPLC_C_LIB` (C headers for the `g++ -c` step, e.g. `$HOME/OpenPLC_v3/webserver/core/lib`).
Use absolute paths; `.env` does not expand `$HOME`.

## 4. STruC++ (builds the OpenPLC v4 `program.zip`)

OpenPLC Runtime v4 only accepts STruC++ bundles. The worker builds them in-process with the STruC++ npm package
(`OPENPLC_BUILDER=strucpp`, the default). It is not on the npm registry; install the release tarball **without saving**:

```bash
cd ~/mongomation
npm i --no-save --ignore-scripts https://github.com/Autonomy-Logic/STruCpp/releases/download/v0.7.0/strucpp-0.7.0.tgz
node -e "import('strucpp/node').then(m=>console.log(m.getVersion()))"    # verify
```

- Run the worker with the repo root as the working directory (it loads `node_modules/strucpp` from `cwd`).
- Re-run the install after every `npm ci` / pruning `npm install`.
- Alternative, only when the worker runs **on the Linux rig host**: `OPENPLC_BUILDER=docker:plc-builder` uses the
  rig's own builder image (`docker run --rm -v <dir>:/work plc-builder /work/main.st /work/out`).

## 5. Rig access

### 5.0 Team gateway (preferred: any network, no AWS, no VPN)

The rig owner's kit puts both APIs behind one HTTPS gateway with path prefixes. Every OpenPLC and Factory I/O request
must carry `X-Team-Key: <TEAM_API_KEY>`; OpenPLC still needs its own JWT login (`/api/login`, user `autominus`).
The certificate is self-signed. Without the key the gateway answers HTTP 401 (`missing or wrong X-Team-Key`), which is
also the quickest reachability check.

```bash
# ~/mongomation/.env (gitignored; values from the private rig kit)
OPENPLC_URL=https://<GATEWAY>/openplc      # paths are appended: <GATEWAY>/openplc/api/login, /api/status, ...
FACTORYIO_URL=https://<GATEWAY>/factoryio  # <GATEWAY>/factoryio/api/tags, ...
OPENPLC_INSECURE_TLS=true
FACTORYIO_INSECURE_TLS=true
FACTORYIO_HOST_HEADER=                     # leave EMPTY with the gateway
# Secrets: link the kit's .env instead of copying (every npm script loads .env, then .env.rig; the later file wins)
#   ln -sf /mnt/c/<path to kit>/.env ~/mongomation/.env.rig      # gitignored; provides TEAM_API_KEY + OPENPLC_PASSWORD
```

Check: `npm run rig:smoke` (read-only; prints `team key set|empty`, never values; every row must be ✓). Then go to §6.

#### 5.0b Older direct NAT access (team Wi-Fi allowlist; superseded by the gateway)

The rig owner exposes the two APIs on the rig's public address, allowlisted to the team Wi-Fi's public IP only.
Check yours first: `curl -s https://checkip.amazonaws.com` must print the allowlisted IP (in the private handoff);
from any other network the connections time out. Values are in the private handoff; put them in your gitignored `.env`:

```bash
OPENPLC_URL=https://<RIG_PUBLIC_IP>:8444          # OpenPLC v4 REST, self-signed cert -> OPENPLC_INSECURE_TLS=true
FACTORYIO_URL=http://<RIG_PUBLIC_IP>:7410         # Factory I/O Web API (NAT)
FACTORYIO_HOST_HEADER=<RIG_FIO_HOST>:7410         # REQUIRED for direct access: every Factory I/O request sends this Host
OPENPLC_USER=autominus
OPENPLC_PASSWORD=                                 # type it into .env yourself (rig owner / SSM); never paste it in chat
```

The worker and `rig:smoke` send `FACTORYIO_HOST_HEADER` via `node:http` (Node's `fetch` silently drops a custom
`Host` header). Leave it empty when using the SSM tunnels below. The 3D view (DCV, port 8443 on the same address) is
browser-only. Then go to §6. If the direct ports time out, the rig is stopped or your IP is not allowlisted: ask the
rig owner, or fall back to the SSM tunnels.

### 5.1-5.5 Fallback: AWS SSM port forwarding (in WSL)

Only the person with AWS access to the rig (team: the teammate who owns the rig login) does this section. Agents and
scripts never log in or change AWS resources; they only read the SSM parameter and port-forward.

The rig APIs are private. You reach them through AWS Systems Manager port forwarding.
**WSL2 runs in NAT mode, so a tunnel opened on Windows is not reachable from WSL.** Run the tunnels in WSL, in the
same environment as the worker.

### 5.1 Install AWS CLI v2 + Session Manager plugin (user space, no sudo)

```bash
# AWS CLI v2
cd /tmp && curl -sSLo awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
unzip -q awscliv2.zip && ./aws/install -i ~/.local/aws-cli -b ~/.local/bin
# Session Manager plugin (extract the .deb, no root needed)
curl -sSLo ssm.deb https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb
dpkg-deb -x ssm.deb ~/.local/smp
ln -sf ~/.local/smp/usr/local/sessionmanagerplugin/bin/session-manager-plugin ~/.local/bin/session-manager-plugin
aws --version && session-manager-plugin --version     # tested: aws-cli 2.37.12, plugin 1.2.896.0
```

`~/.local/bin` must be on `PATH` (Ubuntu's `~/.profile` adds it for login shells, i.e. `wsl -- bash -lc ...`).
If WSL's `~/.aws` is a symlink to the Windows `~/.aws`, one login covers both.

### 5.2 Log in (you do this yourself; agents never log in for you)

Use the IAM Identity Center / IAM user the rig owner gave you (never the root login), region `us-west-2`:

```bash
aws login --remote     # in WSL (no local browser); or: aws configure sso && aws sso login
aws sts get-caller-identity
```

### 5.3 Open the tunnels

Keep them running while the worker runs. The instance id and the Factory I/O private IP come from the private
handoff. Put them in your gitignored `.env` (`RIG_INSTANCE=`, `RIG_FIO_HOST=`) or export them in the shell (the
shell wins); the script exits 3 with a pointer to the handoff if either is missing. Never put them in tracked files.

```bash
# optional: RIG_REGION (default us-west-2), AWS_PROFILE

bash scripts/rig-tunnels.sh start          # background tunnels 8443 + 7410, waits until each is ready
bash scripts/rig-tunnels.sh start --modbus # also localhost:5020 -> OpenPLC Modbus :502
bash scripts/rig-tunnels.sh status         # pid + port check per tunnel
bash scripts/rig-tunnels.sh logs           # tail /tmp/rig-tunnel-<port>.log
bash scripts/rig-tunnels.sh stop
```

| Local port | Target | Used for |
|---|---|---|
| `localhost:8443` | OpenPLC REST (HTTPS, self-signed) | `OPENPLC_URL` |
| `localhost:7410` | Factory I/O Web API (on the Windows sim host) | `FACTORYIO_URL` |
| `localhost:5020` | OpenPLC Modbus TCP :502 (optional, raw Modbus only) | debugging |

`scripts/rig-tunnels.ps1` is the Windows variant; it only helps when the worker also runs on Windows (not WSL).
Manual equivalent of `start` (one terminal each):

```bash
aws ssm start-session --region us-west-2 --target "$RIG_INSTANCE" \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=8443,localPortNumber=8443
aws ssm start-session --region us-west-2 --target "$RIG_INSTANCE" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters host=$RIG_FIO_HOST,portNumber=7410,localPortNumber=7410
```

### 5.4 Load the rig password into the environment

The OpenPLC API password lives in SSM Parameter Store (`OPENPLC_PASSWORD_SSM_PARAM`, default
`/autominus/openplc-api-password`). Never write it into `.env` in a shared checkout; load it per shell:

```bash
source scripts/rig-env.sh              # exports OPENPLC_PASSWORD for this shell only (value never printed)
                                       # + OPENPLC_URL/USER/INSECURE_TLS/FACTORYIO_URL tunnel defaults if unset
bash scripts/rig-env.sh --write-env    # alternative: writes it into the OPENPLC_PASSWORD= line of ./.env (gitignored)
```

It must be **sourced** (executing it without `--write-env` only affects a subshell and exits 1). Node's
`--env-file-if-exists=.env` does not override variables already set in the shell, so the exported value wins over an
empty `OPENPLC_PASSWORD=` line in `.env`. Start the worker from the same shell.

### 5.5 Rig settings (already the defaults in `.env.example`)

```
OPENPLC_FLAVOR=v4  OPENPLC_URL=https://localhost:8443  OPENPLC_USER=autominus  OPENPLC_INSECURE_TLS=true
OPENPLC_MODBUS_MODE=server   # Factory I/O is the Modbus client of OpenPLC on this rig (also the code default)
FACTORYIO_URL=http://localhost:7410   FACTORYIO_TIMEOUT_MS=15000   FACTORYIO_RELINK_MS=65000
SCENE_ID=sorting-by-height-basic
```

After every upload Factory I/O loses the Modbus link for ~60 s and reconnects by itself; the worker waits
`FACTORYIO_RELINK_MS` before it judges plant behaviour.

## 6. Check the rig, then run

```bash
npm run rig:smoke      # read-only: OpenPLC login/ping/status + Factory I/O tags vs the scene file (no writes)
npm run green          # all rows, incl. openplc + factoryio via the worker's own clients
npm run launcher       # worker under the launcher (needed for Interrupt Worker / Resume from MongoDB)
```

Then use the dashboard (https://mongomation-mv43qiu7n6f-prod.cloud.modelence.app) or the CLI equivalents:
`npm run example`, `npm run fault`, `npm run evolve`, `npm run benchmark`, `npm run ablation`, `npm run ledger`.
See `docs/DEMO_RUNBOOK.md` for the recorded demo order.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| direct access: `timed out` on `<RIG_PUBLIC_IP>:8444` / `:7410` | not on the team Wi-Fi (check `curl -s https://checkip.amazonaws.com`), or the rig is stopped — ask the rig owner (§5.0) |
| direct access: Factory I/O HTTP 4xx/404 or wrong host | `FACTORYIO_HOST_HEADER` missing/wrong in `.env` (§5.0) |
| `ECONNREFUSED 127.0.0.1:8443` / `:7410` | tunnels not running, or opened on Windows instead of WSL (§5) |
| `OPENPLC_PASSWORD is not set` | `source scripts/rig-env.sh` in the same shell that starts the worker |
| `TargetNotConnected` / `AccessDenied` from `aws ssm` | not logged in, expired session, or missing IAM permission — ask the rig owner |
| `STruC++ not installed` | §4 (wiped by `npm ci`) |
| Tests BLOCKED right after a deploy | Modbus relink still in progress; keep `FACTORYIO_RELINK_MS=65000` |
| Atlas timeouts | Atlas → Network Access → add the current IP |
