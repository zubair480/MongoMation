# MongoDB official tooling: developer reference for MongoMation

Researched 2026-10-11. Scope: TypeScript/Node 22 worker plus web dashboard, with a MongoDB Atlas hackathon sandbox cluster as the source of truth for agent state, the job queue, checkpoints, memory/lessons (vector search), and versioned harness configs.

## How this was verified (read first)

- **Labels.** `[V]` means verified against a primary source: official docs source, a package's shipped code or typings, a local `tsc` compile, the local CLI `--help`, or an MCP server `--dryRun`. `[UNVERIFIED]` means inferred or not confirmed. Everything unlabelled comes from the official docs source cited in that section.
- **mongodb.com was blocked.** The egress proxy blocked `www.mongodb.com` for both WebFetch and curl. Instead, the official docs source was read from the public docs monorepo **github.com/mongodb/docs** (commit `8b7c63d`, 2026-10-09). A docs page at `content/<project>/source/<path>.txt` is published at `https://www.mongodb.com/docs/<project>/<path>/`. The URLs below are derived that way.
- **Other sources read:**
  - npm registry: `npm view`, plus `npm pack` of the actual package code.
  - PyPI JSON API.
  - github.com/mongodb-js/mongodb-mcp-server (README on main).
  - github.com/mongodb/agent-skills (`c370a63`, 2026-10-08).
  - github.com/langchain-ai/langgraphjs (`7789c52`).
  - github.com/langchain-ai/docs (`cd302e5`).
  - github.com/langchain-ai/langchain-mongodb (`190ffbf`).
  - github.com/mongodb-developer/GenAI-Showcase (`70b3715`, 2026-09-04).
  - Local `claude` CLI 2.1.296 `--help`.
  - `npx mongodb-mcp-server@3.0.5 --dryRun`. This makes no DB connection and uses no credentials.
- **Compile checks.** All TypeScript snippets in sections 4, 5 and 7 were compiled with `tsc --strict`:
  - against `mongodb@6.21.0`, `voyageai@0.4.0`, `@langchain/langgraph@1.4.21` and `@langchain/langgraph-checkpoint-mongodb@1.4.2`;
  - the driver-only snippets also against `mongodb@7.7.0`.
- **No live testing.** Nothing was run against a database.

## 0. Version matrix (npm / PyPI, 2026-10-11) [V]

| Package | Latest | Notes |
|---|---|---|
| `mongodb-mcp-server` (npm) | **3.0.5** (2026-10-01) | Other tags: `v2`=2.1.2, `pre`=3.1.0-pre.1. engines: `node ^20.19.0 \|\| ^22.13.0 \|\| >=24.0.0`. The README says use Node >= 22.13. Docker image: `mongodb/mongodb-mcp-server:latest`. |
| `mongodb-atlas-mcp-remote` (npm) | 1.0.0 | stdio proxy to the hosted Atlas MCP server, using OAuth2 client credentials. |
| `mongodb` (Node driver) | **7.7.0** (2026-09-28) | engines `node >=20.19.0`. Latest 6.x is **6.21.0** (dist-tag `6x`). |
| `@langchain/langgraph` | 1.4.21 | deps `@langchain/langgraph-checkpoint ^1.1.6`; peer `@langchain/core ^1.1.48`. |
| `@langchain/langgraph-checkpoint` | 1.1.6 | |
| `@langchain/langgraph-checkpoint-mongodb` | **1.4.2** (2026-10-06) | **deps `mongodb ^6.21.0`** (see caveat C1); peers `@langchain/core ^1.1.44`, `@langchain/langgraph-checkpoint ^1.1.4`; exports `MongoDBSaver` and `MongoDBStore`. |
| `@langchain/mongodb` (vector store) | 1.3.1 | deps `mongodb ^6.20.0`. |
| `voyageai` (npm, TS client) | 0.4.0 | Default base URL is `https://api.voyageai.com/v1`. |
| PyPI `langgraph-checkpoint-mongodb` | 0.5.1 | Python >= 3.11. |
| PyPI `langgraph-store-mongodb` | 0.4.0 | |
| PyPI `langchain-mongodb` / `pymongo` / `voyageai` | 0.12.1 / 4.18.3 / 0.5.0 | |
| Claude/Cursor plugins `mongodb`, `mongodb-atlas` | 1.2.1 | Defined in github.com/mongodb/agent-skills. |

Do not use the PyPI package named `mongodb-mcp-server` (0.1.1). It is not the official server, which is the npm package from `mongodb-js`. [V that it exists on PyPI; its owner was not checked]

---

## 1. Official MongoDB MCP Server, local/self-run (`mongodb-mcp-server`)

**Sources:**
- github.com/mongodb-js/mongodb-mcp-server (README)
- docs `content/mcp-server/source/get-started.txt`, `tools.txt`, `prerequisites.txt`, `overview.txt`. Published at https://www.mongodb.com/docs/mcp-server/get-started/, /tools/, /prerequisites/ and /overview/.
- npm package source `@mongodb-js/mcp-tools-*@3.0.5`
- `--dryRun` output

### 1.1 Setup in Claude Code

**Official MongoDB doc route** (`step-claude-code-add-json.rst`, `mcp-config-claude-code-self.json`) [V]:

```bash
claude mcp add-json mongodb '{"type":"stdio","command":"npx","args":["-y","mongodb-mcp-server@latest","--readOnly"],"env":{"MDB_MCP_CONNECTION_STRING":"<connection-string>"}}'
claude mcp get mongodb
```

The Atlas service-account variant (`mcp-config-claude-code-atlas.json`) swaps `env` for `{"MDB_MCP_API_CLIENT_ID":"<client-id>","MDB_MCP_API_CLIENT_SECRET":"<client-secret>"}`.

**Equivalent `claude mcp add`.** The syntax was verified with the local `claude mcp add --help` and the Claude Code docs at code.claude.com/docs/en/mcp. The docs say: "place at least one other option, such as `--transport stdio`, between `--env` and the server name". Everything after `--` is passed to the server. Default scope is `local`; other values are `project` (writes `.mcp.json`) and `user`.

```bash
export MDB_MCP_CONNECTION_STRING='mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?appName=mongomation-mcp'
claude mcp add --env MDB_MCP_CONNECTION_STRING="$MDB_MCP_CONNECTION_STRING" --transport stdio mongodb \
  -- npx -y mongodb-mcp-server@latest --readOnly
```

**Team-shared, project-scoped `.mcp.json`.** Claude Code expands `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url` and `headers` [V Claude Code docs], so no secret is committed:

```json
{
  "mcpServers": {
    "mongodb": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server@3.0.5", "--readOnly"],
      "env": {
        "MDB_MCP_CONNECTION_STRING": "${MDB_MCP_CONNECTION_STRING}",
        "MDB_MCP_TELEMETRY": "disabled"
      }
    }
  }
}
```

**Plugin route (bundles MCP and Agent Skills; see section 3).** Run `/plugin install mongodb@claude-plugins-official`, then the `/mongodb:mongodb-mcp-setup` skill. This route runs the local server.

### 1.2 Setup in Cursor (`.cursor/mcp.json` in the project or home dir) [V docs `common-mcp-config-self.json`]

```json
{
  "mcpServers": {
    "mongodb": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mongodb-mcp-server@latest", "--readOnly"],
      "env": {
        "MDB_MCP_CONNECTION_STRING": "<connection-string>"
      }
    }
  }
}
```

- For Atlas service-account credentials, use `MDB_MCP_API_CLIENT_ID` and `MDB_MCP_API_CLIENT_SECRET` instead (`common-mcp-config-atlas.json`).
- One-click install link from the docs: `https://cursor.com/en-US/install-mcp?name=MongoDB&config=eyJjb21tYW5kIjoibnB4IC15IG1vbmdvZGItbWNwLXNlcnZlciAtLXJlYWRPbmx5In0%3D`. It decodes to `npx -y mongodb-mcp-server --readOnly`.
- Cursor supports `${env:NAME}`, `${workspaceFolder}` and an `envFile` field in mcp.json. This comes from a search snippet of cursor.com/docs/mcp, because cursor.com could not be fetched. [UNVERIFIED-ish] For example: `"MDB_MCP_CONNECTION_STRING": "${env:MDB_MCP_CONNECTION_STRING}"`.

**Interactive setup alternative:** `npx -y mongodb-mcp-server@latest setup`. It prompts for read-only mode, the connection string and the config file path. [V README and docs]

### 1.3 Configuration: env vars and CLI flags

- **Format.** The CLI flag is the camelCase option name and the env var is `MDB_MCP_<UPPER_SNAKE>`.
- **Precedence:** CLI > env > config file (`MDB_MCP_CONFIG`).
- **Secrets.** Pass them via env, not CLI args, because args show up in process lists. [V README and dry-run defaults]

| Env var / flag | Default | Meaning |
|---|---|---|
| `MDB_MCP_CONNECTION_STRING` / `--connectionString` | unset | Direct DB connection. If unset, the agent must call the `connect` tool. |
| `MDB_MCP_API_CLIENT_ID` / `--apiClientId` | unset | Atlas **service account** client ID. Required for Atlas tools. |
| `MDB_MCP_API_CLIENT_SECRET` / `--apiClientSecret` | unset | Atlas service account secret. |
| `MDB_MCP_READ_ONLY` / `--readOnly` | `false` | Registers only `read`, `connect` and `metadata` tools. **`create-index` and `insert-many` disappear** (verified by dry-run). |
| `MDB_MCP_DISABLED_TOOLS` / `--disabledTools` | `""` | Tool names, operation types (`create`, `update`, `delete`, `read`, `metadata`, `connect`) or categories (`atlas`, `mongodb`). Env form is comma-separated; CLI form is space-separated. |
| `MDB_MCP_CONFIRMATION_REQUIRED_TOOLS` | `atlas-create-access-list,atlas-create-db-user,drop-database,drop-collection,delete-many,drop-index,atlas-streams-manage,atlas-streams-teardown` | Needs client elicitation support. `aggregate` also always confirms `$out`/`$merge`. |
| `MDB_MCP_INDEX_CHECK` / `--indexCheck` | `false` | Reject collection-scan queries. |
| `MDB_MCP_DISABLE_SERVER_SIDE_JS` | `true` | Blocks `$where`, `$function` and `$accumulator`. |
| `MDB_MCP_MAX_DOCUMENTS_PER_QUERY` / `MDB_MCP_MAX_BYTES_PER_QUERY` | `100` / `16777216` | Result caps for `find`/`aggregate`. |
| `MDB_MCP_MAX_TIME_M_S` / `--maxTimeMS` | unset | `maxTimeMS` for reads. |
| `MDB_MCP_LOGGERS` / `--loggers` | `disk,mcp` | Options: `disk`, `mcp`, `stderr`. |
| `MDB_MCP_LOG_PATH` / `--logPath` | `~/.mongodb/mongodb-mcp/.app-logs` | |
| `MDB_MCP_MCP_CLIENT_LOG_LEVEL` | `debug` | |
| `MDB_MCP_TELEMETRY` / `--telemetry` | `enabled` | Use `disabled`, or set `DO_NOT_TRACK=1`. |
| `MDB_MCP_TRANSPORT` / `--transport` | `stdio` | `stdio` or `http`. For http: `MDB_MCP_HTTP_HOST` (127.0.0.1), `MDB_MCP_HTTP_PORT` (3000), `MDB_MCP_HTTP_HEADERS`, `MDB_MCP_HTTP_RESPONSE_TYPE` (`sse`/`json`). Non-loopback binding requires `MDB_MCP_DANGEROUS_HOST_BINDING=true`. |
| `MDB_MCP_CONNECTION_SCOPE` | `session` | Deprecated; will become `global`. |
| `MDB_MCP_MAX_ACTIVE_CONNECTIONS` / `MDB_MCP_CONNECTION_IDLE_TIMEOUT_MS` | `10` / `600000` | |
| `MDB_MCP_ATLAS_TEMPORARY_DATABASE_USER_LIFETIME_MS` | `14400000` (4 h) | Lifetime of the temporary DB user that `atlas-connect-cluster` creates. |
| `MDB_MCP_EXPORTS_PATH`, `MDB_MCP_EXPORT_TIMEOUT_MS`, `MDB_MCP_EXPORT_CLEANUP_INTERVAL_MS` | | For the `export` tool. |
| `MDB_MCP_PREVIEW_FEATURES` / `--previewFeatures` | `""` | The only listed value is `mcpUI`. |
| `MDB_MCP_VOYAGE_API_KEY` / `--voyageApiKey` | `""` | The README says it is "required for creating Atlas Local deployments with auto-embed". |
| `MDB_MCP_DRY_RUN` / `--dryRun` | `false` | Prints the config and enabled tools, then exits. Use it to audit the tool list. |
| `MDB_MCP_ASSISTANT_BASE_URL` | `https://knowledge.mongodb.com/api/v1/` | For the knowledge tools. |
| Proxy | | `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`. |

**Atlas tool prerequisites.** Atlas tools need a **service account** (Atlas > Project Identity & Access > Create Application > Service Account). The README says to add your IP to the service account's API access list. Prefer project-level roles such as Project Read Only, Project Cluster Manager or Project Database Access Admin. The server does not hide tools based on the service account's permissions; a call simply fails. [V prerequisites.txt]

### 1.4 Full tool list, `mongodb-mcp-server@3.0.5` [V source `toolName` constants plus `--dryRun`]

- **Database tools (25).** These are always registered.
  - **Read, metadata and connection:** `aggregate`, `aggregate-db`, `collection-indexes`, `collection-schema`, `collection-storage-size`, `connect`, `count`, `db-stats`, `disconnect`, `explain`, `export`, `find`, `list-collections`, `list-connections`, `list-databases`, `mongodb-logs`.
  - **Write:** `create-collection`, `create-index`, `delete-many`, `drop-collection`, `drop-database`, `drop-index`, `insert-many`, `rename-collection`, `update-many`.
- **Atlas tools (22).** These are registered only when `apiClientId` and `apiClientSecret` are set: `atlas-connect-cluster`, `atlas-create-access-list`, `atlas-create-cluster`, `atlas-create-db-user`, `atlas-create-free-cluster`, `atlas-create-project`, `atlas-get-performance-advisor`, `atlas-get-regions`, `atlas-inspect-access-list`, `atlas-inspect-cluster`, `atlas-list-alerts`, `atlas-list-clusters`, `atlas-list-db-users`, `atlas-list-orgs`, `atlas-list-projects`, `atlas-load-sample-dataset`, `atlas-pause-resume-cluster`, `atlas-streams-build`, `atlas-streams-discover`, `atlas-streams-manage`, `atlas-streams-teardown`, `atlas-upgrade-cluster`.
- **Atlas Local tools (4)** (Docker): `atlas-local-connect-deployment`, `atlas-local-create-deployment`, `atlas-local-delete-deployment`, `atlas-local-list-deployments`.
- **Assistant tools (2):** `list-knowledge-sources`, `search-knowledge`. These search MongoDB's official documentation knowledge base.
- **Read-only mode.** `--readOnly` leaves 20 tools: `aggregate-db`, `aggregate`, `collection-indexes`, `collection-schema`, `collection-storage-size`, `connect`, `count`, `db-stats`, `disconnect`, `explain`, `export`, `find`, `list-collections`, `list-connections`, `list-databases`, `mongodb-logs`, `atlas-local-list-deployments`, `atlas-local-connect-deployment`, `search-knowledge`, `list-knowledge-sources`.
- **Docs drift.** The docs tool table still lists `update-one` and `switch-connection` for Local; neither exists in 3.0.5. The repo's self-managed plugin pins `npx -y mongodb-mcp-server@<3`, which is the v2 line. Trust `--dryRun` for your installed version.

### 1.5 Can it create Atlas Vector Search indexes? Yes [V `createIndex.js` in 3.0.5]

`create-index` takes `definition: [ {type:"classic", keys} | {type:"vectorSearch", fields:[...]} | {type:"search", mappings...} ]`. For `vectorSearch`, the `fields` array allows three field types:

- `{type:"vector", path, numDimensions (1-8192, default 1024), similarity: "cosine"|"euclidean"|"dotProduct" (default "euclidean"), quantization: "none"|"scalar"|"binary"}`
- `{type:"autoEmbed", path, model: "voyage-4"|"voyage-4-large"|"voyage-4-lite"|"voyage-code-3", modality:"text"}`
- `{type:"filter", path}`

How it works and what to watch:
- **Implementation.** It calls `createSearchIndexes(... type:"vectorSearch")`. Use `collection-indexes` to poll build status. `drop-index` drops search indexes too.
- **No updates.** An index cannot be updated through MCP. Drop it and recreate it.
- **Write mode required.** Vector index creation needs **non-read-only** mode.
- **Search over MCP.** `aggregate` supports `$vectorSearch`, with either `queryVector` (classic) or `query:{text}` plus an optional `model` (autoEmbed). The `aggregate` tool prompt tells the LLM to `$unset` embedding fields.
- **Docs drift.** The docs say the MCP server embeds documents and queries client-side via `voyageApiKey` (voyage-3.x models). That `embeddingParameters` input does not exist in the 3.0.5 schemas I inspected. [Treat MCP-side embedding as UNVERIFIED for v3; use autoEmbed indexes or pass `queryVector`.]
- **Preview flag.** The old note "vector search in MCP needs `previewFeatures=search`" is stale; 3.0.5 has no such gate. [V source]

---

## 2. Atlas Managed MCP Server (hosted by MongoDB). It exists.

**Sources:** docs `overview.txt` (section "MongoDB Atlas Managed MCP Server"), `remote-mcp/access-models.txt`, `remote-mcp/security.txt`, `remote-mcp/rate-limits.txt`, `includes/get-started/clients/*.rst`, and agent-skills `plugins/mongodb-atlas/.claude-plugin/plugin.json`.

- **What it is.** MongoDB runs the MCP server in Atlas. There is nothing to deploy, upgrade or rotate, and no connection string is exposed to the AI client.
  - Atlas clusters only.
  - Up to project-level data-plane access. The local server can be scoped down to the collection level.
  - Implements MCP spec `2025-11-25`.
- **URL:** `https://mcp.mongodb.com` (the docs and the plugin manifest use `https://mcp.mongodb.com/`).
- **Tool set.** It is mostly the same as the local server.
  - **Atlas-Managed only:** `remote-atlas-connect`. It returns a connection handle for later DB tools. The docs table also marks `aggregate-db` and `atlas-load-sample-dataset` as managed-only, but both exist in local 3.0.5 (dry-run).
  - **Not available on Atlas-Managed** (docs table): `connect`, `export`, `mongodb-logs`, `atlas-connect-cluster` and `atlas-create-access-list`.
  - Read-only is preselected on MCP configurations.
- **Rate limits:** 2,000 requests/min per IP and 500 requests/min per user. Exceeding them returns HTTP 429, so back off with jitter and honour `Retry-After`.

**Access model A: user-delegated, via OAuth 2.1 with PKCE (interactive coding).** This uses the `mongodb-atlas` plugin.
- **Prerequisite:** an **Organization Owner must enable "Allow users to connect AI clients"** (Atlas > Organization Settings > App Connections). It is disabled by default, except in orgs that Atlas created at user sign-up.
- **Supported clients:** ChatGPT, Claude Code, Claude Desktop/Web, Codex, Cursor, Devin, fx, Grok Build.
- **Access lifetime:** access ends after 7 days of inactivity or 30 days after grant.
- **Claude Code setup:**
  ```
  /plugin install mongodb-atlas@claude-plugins-official
  /reload-plugins
  /mcp            # select plugin:mongodb-atlas:mongodb-atlas -> Authenticate, then Authorize in the browser
  ```
- **Plugin MCP config.** The plugin manifest's MCP block is `{"type":"http","url":"https://mcp.mongodb.com/","oauth":{"clientId":"https://claude.ai/oauth/claude-code-client-metadata"}}` [V]. A hand-made equivalent would be `claude mcp add --transport http --client-id https://claude.ai/oauth/claude-code-client-metadata mongodb-atlas https://mcp.mongodb.com/`. [UNVERIFIED: the docs only document the plugin.]
- **Cursor setup:** Cursor Settings > Customize > Browse Marketplace > "MongoDB Atlas" > Add, then Tools & MCPs > Authenticate > MongoDB-Atlas. Alternatively, `/add-plugin mongodb-atlas` in the agent.

**Access model B: programmatic, via MCP Configurations and OAuth client credentials (automated agents).** An Org Owner or Project Owner creates an MCP configuration. Atlas then creates ingress and egress service accounts, roles, an optional IP access list, and a read-only flag that is preselected. You receive a `clientId` and `secret`.

Atlas CLI >= 1.58.0 flow (`-P mcp` is the CLI profile name):

```bash
atlas auth login -P mcp
export GROUP_ID="<project-id>"; export MY_IP="<your-ip>"
cat > /tmp/mcp-config.json <<EOF
{"mcpConfigName":"my-config","roles":["GROUP_OWNER"],"ipAccessList":[{"ipAddress":"$MY_IP"}]}
EOF
read -r MCP_CONFIG_ID CLIENT_ID <<< "$(atlas api remoteMcpConfigurations createGroupMcpConfig \
  --groupId "$GROUP_ID" --file /tmp/mcp-config.json -P mcp -o '{{.mcpConfigId}} {{.clientId}}')"
echo '{"secretExpiresAfterHours": 8760}' > /tmp/mcp-secret.json
SECRET=$(atlas api remoteMcpConfigurations createGroupMcpSecret --groupId "$GROUP_ID" \
  --mcpConfigId "$MCP_CONFIG_ID" --file /tmp/mcp-secret.json -P mcp -o '{{.secret}}')   # secret shown once
```

- Use org-level `createOrgMcpConfig` / `createOrgMcpSecret` with `"roles":["ORG_OWNER"]` for org scope.
- The Admin API equivalent is `POST https://cloud.mongodb.com/api/atlas/v2/groups/$GROUP_ID/mcpConfigs` and `.../mcpConfigs/$MCP_CONFIG_ID/secrets`, using digest auth and `Accept: application/vnd.atlas.2025-03-12+json`.
- The docs example uses `GROUP_OWNER`. Narrower role names exist in Atlas but were not tested with this API. [UNVERIFIED]

Clients without OAuth client-credentials support use the stdio proxy (Claude Code / Cursor config):

```json
{ "mcpServers": { "mongodb-atlas-mcp-remote": {
  "type": "stdio", "command": "npx", "args": ["-y", "mongodb-atlas-mcp-remote@latest"],
  "env": { "MDB_MCP_API_CLIENT_ID": "<CLIENT_ID>", "MDB_MCP_API_CLIENT_SECRET": "<SECRET>" } } } }
```

**From your own agent code** (the docs show a Python MCP SDK sample):
1. POST `https://cloud.mongodb.com/api/oauth/token` with `Authorization: Basic base64(clientId:secret)` and form body `grant_type=client_credentials`.
2. Call `https://mcp.mongodb.com` over streamable HTTP with these headers: `Authorization: Bearer <access_token>`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-11-25`.

A TypeScript equivalent with `@modelcontextprotocol/sdk` should work but was not tested. [UNVERIFIED for TS]

---

## 3. Official MongoDB Agent Skills

**Sources:** github.com/mongodb/agent-skills (README.md, README.community.md, `.claude-plugin/marketplace.json`, plugin manifests); docs `content/landing/source/agent-skills.txt`, `claude.txt`, `cursor.txt` (https://www.mongodb.com/docs/agent-skills/).

**Skills.** Repo `skills/` holds 8 skills, all Apache-2.0:

| Skill | Purpose |
|---|---|
| `mongodb-mcp-setup` | Configure MCP credentials. Only in the `mongodb` (self-managed) plugin. |
| `mongodb-connection` | Pool, timeout and serverless connection tuning. |
| `mongodb-schema-design` | Patterns and anti-patterns, including time series, document versioning, schema versioning and TTL references. |
| `mongodb-natural-language-querying` | Read-only find/aggregate generation. |
| `mongodb-query-optimizer` | Indexes, `explain`, Performance Advisor. |
| `mongodb-search-and-ai` | Atlas Search, Vector Search, hybrid search, automated embedding. |
| `mongodb-atlas-stream-processing` | Atlas Stream Processing. |
| `mongodb-qe-size-estimation` | Queryable Encryption sizing. |

**Plugins.** Each plugin bundles the skills plus an MCP server config:

- **`mongodb-atlas`** ("MongoDB Atlas (Managed MCP)", v1.2.1). Connects over HTTP with OAuth to `https://mcp.mongodb.com/`.
- **`mongodb`** ("MongoDB (Self-Managed MCP)", v1.2.1).
  - MCP config: `npx -y mongodb-mcp-server@<3`.
  - It reads `MDB_MCP_*` variables from your shell environment.
  - Run the `mongodb-mcp-setup` skill to configure it.

**Install commands:**

Claude Code (official Anthropic marketplace):
```bash
# terminal (docs: content/landing/source/claude.txt)
claude plugin install mongodb@claude-plugins-official          # self-managed/local MCP + skills
claude plugin install mongodb-atlas@claude-plugins-official    # hosted Atlas MCP (OAuth) + skills
# or inside a Claude Code session:
/plugin install mongodb-atlas@claude-plugins-official   # then /reload-plugins
```
- Alternative: add MongoDB's own marketplace, named `mongodb-plugins` in `.claude-plugin/marketplace.json`:
  ```bash
  claude plugin marketplace add mongodb/agent-skills
  claude plugin install mongodb@mongodb-plugins
  ```
  This is standard Claude Code plugin CLI syntax (verified via local `--help`), but MongoDB's docs do not show it. [UNVERIFIED as documented]
- Skills can be invoked as `/<skill-name>` in Claude Code.

Cursor:
- Agent chat: `/add-plugin mongodb` or `/add-plugin mongodb-atlas`.
- Or: Cursor Settings > Marketplace, search "MongoDB" or "MongoDB Atlas", then Add.
- Marketplace pages: https://cursor.com/marketplace/mongodb and https://cursor.com/marketplace/mongodb-atlas.

Skills only, any agent (Vercel skills.sh CLI):
```bash
npx skills add mongodb/agent-skills
npx skills add https://github.com/mongodb/agent-skills --skill mongodb-mcp-setup   # single skill (MCP README)
```
Or `git clone https://github.com/mongodb/agent-skills.git` and copy `skills/` to your agent's skills dir.

Other clients: Codex uses `codex plugin marketplace add mongodb/agent-skills` then `/plugins`. Gemini uses `gemini extensions install https://github.com/mongodb/agent-skills`. Copilot CLI uses `copilot plugin install mongodb-atlas`.

**Docs drift:**
- The Agent Skills docs page says `npx mongodb-mcp-server@1 setup`. That is old; use `@latest`.
- The GenAI-Showcase `mcp/README.md` tool list is outdated: it lists `insert-one` and `delete-one`, which do not exist.

---

## 4. LangGraph checkpointing with MongoDB

### 4.1 JS/TS package facts

**Sources:**
- npm `@langchain/langgraph-checkpoint-mongodb@1.4.2`: `dist/checkpoint.d.ts`, `checkpoint.js`, `store.d.ts`, `store.js`.
- langgraphjs `libs/checkpoint-mongodb/README.md`.
- LangChain docs `src/oss/javascript/integrations/memory/mongodb-short-term-memory.mdx` and `mongodb-long-term-memory.mdx`.

Install command, given caveat C1 below:

```bash
npm i @langchain/langgraph@^1.4.21 @langchain/core@^1.1.48 @langchain/langgraph-checkpoint-mongodb@^1.4.2 mongodb@^6.21.0 zod
```

**C1: driver version mismatch [V via tsc].**
- The checkpointer **depends on `mongodb ^6.21.0`**.
- If the app installs `mongodb@7.x`, npm nests a second copy, and `new MongoDBSaver({ client })` fails to type-check: `TS2322: Type 'MongoClient' is not assignable to type 'MongoClient'` (the `options`/`metadata` fields differ).
- With `mongodb@^6.21.0` in the app, the copies dedupe and it compiles.
- **Recommendation: pin the whole app to `mongodb@^6.21.0`.** v6.21 supports everything below: `createSearchIndex` vectorSearch (>= 6.6.0), `findOneAndUpdate` `returnDocument`, change streams, time series.
- The fallback, casting the client, compiles but runs two drivers and two connection pools. [UNVERIFIED runtime behaviour]

**`MongoDBSaver` constructor** [V `.d.ts`]: `new MongoDBSaver(params: MongoDBSaverParams, serde?: SerializerProtocol)`, where

```ts
type MongoDBSaverParams = {
  client: MongoClient;                       // required, you own its lifecycle
  dbName?: string;                           // passed to client.db(dbName): db from the URI path, else driver default ("test")
  checkpointCollectionName?: string;         // default "checkpoints"
  checkpointWritesCollectionName?: string;   // default "checkpoint_writes"
  enableTimestamps?: boolean;                // writes `upserted_at` on every upsert
  ttl?: number;                              // seconds; implies enableTimestamps; setup() creates TTL index on upserted_at
};
```

- **`setup(): Promise<Error[]>`** creates `thread_ns_checkpoint_idx` `{thread_id:1, checkpoint_ns:1, checkpoint_id:-1}` and `thread_ns_checkpoint_task_idx` `{thread_id:1, checkpoint_ns:1, checkpoint_id:1, task_id:1, idx:1}`, plus the TTL indexes if `ttl` is set. It is idempotent and concurrency-safe. **It returns errors instead of throwing, so check the array.**
- **Other methods:** `getTuple`, `list(config, {limit, before, filter})`, `put`, `putWrites`, `deleteThread(threadId)`.
- **No `fromConnString`** on the JS saver. The JS `MongoDBStore` has `fromConnString`.
- **Doc bug.** The Atlas docs overview page (`ai-integrations/langgraph-js.txt`) shows `new MongoDBSaver(client)` and `graph.compile(checkpointer)`. **Both are wrong for 1.x.** Use `new MongoDBSaver({ client, dbName })` and `compile({ checkpointer })`, as the Atlas tutorial `langgraph-js/build-agents` does.

**Usage, resume after crash, and interrupts** [V compiled; semantics from LangChain docs `checkpointers.mdx`, `fault-tolerance.mdx`, `interrupts.mdx`]:

```ts
import { MongoClient } from "mongodb";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { StateGraph, StateSchema, START, END, Command, interrupt } from "@langchain/langgraph";
import * as z from "zod";

const client = new MongoClient(process.env.MONGODB_URI!);
const checkpointer = new MongoDBSaver({
  client,
  dbName: "mongomation",
  checkpointCollectionName: "checkpoints",
  checkpointWritesCollectionName: "checkpoint_writes",
  ttl: 7 * 24 * 3600,           // optional: expire idle threads (important on a 0.5 GB free cluster)
});
const errs = await checkpointer.setup();
if (errs.length) console.error("checkpointer.setup", errs);

const State = new StateSchema({ step: z.number().default(0), approved: z.boolean().optional() });
const graph = new StateGraph(State)
  .addNode("plan", async (s) => ({ step: s.step + 1 }), { retryPolicy: { maxAttempts: 3 } })
  .addNode("approve", async () => ({ approved: interrupt({ question: "Activate harness config v7?" }) as boolean }))
  .addEdge(START, "plan").addEdge("plan", "approve").addEdge("approve", END)
  .compile({ checkpointer });

const config = { configurable: { thread_id: job.threadId } };   // thread_id = durable pointer (store it on the job doc)

// normal run; "sync" = checkpoint persisted before the next step starts (best crash safety)
await graph.invoke({ step: 0 }, { ...config, durability: "sync" });

// after a crash/restart: same thread_id, null input -> continue from the last checkpoint
const snap = await graph.getState(config);
const waitingOnHuman = snap.tasks.some((t) => (t.interrupts ?? []).length > 0);
if (snap.next.length > 0 && !waitingOnHuman) await graph.invoke(null, { ...config, durability: "sync" });

// human-in-the-loop resume: value becomes the return value of interrupt()
await graph.invoke(new Command({ resume: true }), config);
```

Semantics:
- **Checkpoints and pending writes.** A checkpoint is saved at every super-step. "Pending writes" from nodes that succeeded in a failed super-step are stored in `checkpoint_writes` and are **not re-run** on resume.
- **Durability modes:** `"exit"`, `"async"` and `"sync"`. `"exit"` cannot recover from mid-run crashes. The JS default mode was not confirmed, so **pass `durability: "sync"` explicitly**. [default UNVERIFIED]
- **`invoke(null, config)`** is the documented way to resume a drained run (`RunControl`/`GraphDrained`, `@langchain/langgraph >= 1.4.0`) and to replay or fork from a checkpoint config.
- **Interrupts:**
  - Resume with the **same thread_id** and `new Command({ resume: value })`.
  - **The interrupted node restarts from its beginning**, so code before `interrupt()` re-runs. Make it idempotent.
  - The payload is surfaced in `result.__interrupt__`.
  - `interrupt(payload, { responseSchema: zod })` needs `>= 1.4.16`.
- Graceful SIGTERM pattern:
  ```ts
  const control = new RunControl();
  process.on("SIGTERM", () => control.requestDrain("sigterm"));
  await graph.invoke(inputs, { ...config, control });   // catches GraphDrained; resume later with invoke(null, config)
  ```

### 4.2 Long-term memory in JS: `MongoDBStore` (same package) [V `store.d.ts`/`store.js`, compiled]

```ts
import { MongoDBStore } from "@langchain/langgraph-checkpoint-mongodb";
// Mode 1, auto-embedding (no `embeddings`): Atlas generates embeddings server-side with Voyage.
const store = new MongoDBStore({
  client, dbName: "mongomation", collectionName: "lessons",       // default collectionName "store"
  indexConfig: { name: "lessons_autoembed", path: "value.text", model: "voyage-4" },   // path -> source text
  // ttl: { defaultTtl: 30*24*3600, refreshOnRead: true },
});
// Mode 2, manual embeddings: pass `embeddings` (any LangChain EmbeddingsInterface) + indexConfig { name, dims, similarityFunction, embeddingKey }.
await store.start();   // unique {namespaceStr,key}; TTL {expiresAt} if ttl; createSearchIndex(type:"vectorSearch") if indexConfig
await store.put(["agent", agentId, "lessons"], lessonId, { text: "Back off 30s when gateway returns 503", tags: ["sensor"] });
const hits = await store.search(["agent", agentId, "lessons"], { query: "gateway errors", limit: 5 });  // items with .score
const graph = builder.compile({ checkpointer, store });
```

Caveats:
- **`filter` is ignored when `query` is set.** In 1.4.2, the vector path only pre-filters on `namespacePath`. The MongoDB docs example that combines `query` with `filter:{type:"fact"}` will not filter. Post-filter results yourself.
- **Index lifecycle.** `start()` does not wait for the search index to become queryable.
- **Manual mode with Voyage keys.** A custom `EmbeddingsInterface` wrapping `voyageai` with `environment: "https://ai.mongodb.com/v1"` compiles; the snippet is in `scratchpad/tscheck/check3.ts`.

### 4.3 Python equivalent (brief) [V source `langgraph/checkpoint/mongodb/saver.py`, LangChain docs]

```python
from pymongo import MongoClient
from langgraph.checkpoint.mongodb import MongoDBSaver   # pip install -U langgraph-checkpoint-mongodb pymongo
saver = MongoDBSaver(MongoClient(uri), db_name="checkpointing_db",          # defaults shown
                     checkpoint_collection_name="checkpoints",
                     writes_collection_name="checkpoint_writes", ttl=None)
# or: with MongoDBSaver.from_conn_string(uri, db_name="mongomation") as saver: ...
graph = builder.compile(checkpointer=saver)
graph.invoke(None, {"configurable": {"thread_id": "job-123"}})          # resume
graph.invoke(Command(resume=True), {"configurable": {"thread_id": "job-123"}})  # after interrupt()
```

- **Indexes and async.** Indexes are created in the constructor; there is no `setup()`. There is no separate `AsyncMongoDBSaver` class. The same class has `aget_tuple`, `alist`, `aput`, `aput_writes` and `adelete_thread`. (One LangChain page still mentions `AsyncMongoDBSaver`; the package exports only `MongoDBSaver`.)
- **Long-term memory:** `pip install langgraph-store-mongodb`, then `from langgraph.store.mongodb import MongoDBStore, create_vector_index_config`. Use `with MongoDBStore.from_conn_string(uri, index_config=create_vector_index_config(embed=..., dims=...)) as store:`.

### 4.4 Official examples (paths)

**MongoDB docs, Atlas `ai-integrations`:**
- https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/ (overview; see the doc bug above)
- https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/build-agents/ (TS HR agent: `MongoDBSaver({ client, dbName })`, `compile({ checkpointer })`, `thread_id`)
- https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/long-term-memory-store/ (`MongoDBStore`)
- Python: https://www.mongodb.com/docs/atlas/ai-integrations/langgraph/ and `.../langgraph/build-agents/`

**LangChain docs:**
- https://docs.langchain.com/oss/javascript/integrations/memory/mongodb-short-term-memory
- `.../mongodb-long-term-memory`
- https://docs.langchain.com/oss/langgraph/checkpointers
- `/fault-tolerance`
- `/interrupts`

**Tutorial repo:** github.com/mongodb-developer/LangGraph.js-MongoDB-Example. It is 2024-era (LangGraph 0.1, checkpoint-mongodb 0.0.2). **Use it for the pattern only; do not copy its package.json.**

**GenAI-Showcase** (https://github.com/mongodb-developer/GenAI-Showcase/blob/main/...). The notebooks are Python.

| Path | What it shows |
|---|---|
| `notebooks/memory/langmem_mongodb_notebook.ipynb` | Official `MongoDBSaver` + `MongoDBStore` (langgraph-store-mongodb) + LangMem long-term memory. |
| `notebooks/agents/mongodb_building_a_text_to_mql_agent.ipynb` | Official `MongoDBSaver`, subclassed as a summarizing checkpointer. |
| `notebooks/agents/agentic_rag_factory_safety_assistant_with_langgraph_langchain_mongodb.ipynb` | Agentic RAG with LangGraph. It **hand-rolls a legacy `MongoDBSaver` class**; do not copy that part. |
| `notebooks/agents/asset_management_analyst_assistant_agentic_chatbot_langgraph_mongodb.ipynb` | Agentic chatbot. Same hand-rolled saver caveat. |
| `notebooks/agents/hr_agentic_chatbot_with_langgraph_claude.ipynb` | LangGraph + Claude + `MongoDBChatMessageHistory`. |
| `notebooks/rag/self_querying_mongodb_unstructured_langgraph.ipynb` | Self-querying RAG with LangGraph. |
| `notebooks/agents/implementing_working_memory_with_tavily_and_mongodb.ipynb` | Working memory. |
| `notebooks/memory/memori-mongodb-agent-memory.ipynb` | Agent memory. |
| `apps/ambient-inventory-agent/` | Python FastAPI + LangGraph `create_agent` + **`MongoDBSaver`** (`app/memory.py`) + **Atlas Remote MCP** client-credentials client (`app/mcp_client.py`). The closest analogue to MongoMation. |
| `apps/minimal-ts-agent/` | **TypeScript** (Next.js, Vercel AI SDK v6) + Voyage `voyage-4-lite` query embeddings + `$vectorSearch`, `mongodb@^7.1.0`. Note: it calls `api.voyageai.com`. |
| `apps/remote-mcp-perf-triage/` | Remote MCP + Performance Advisor triage demo. |

There is **no JS LangGraph + MongoDBSaver app** in GenAI-Showcase; the JS reference is the Atlas tutorial above.

---

## 5. Atlas Vector Search

**Sources:** docs `content/vector-search/source/`: `indexes/vector-search-type.txt`, `query/aggregation-stages/vector-search-stage.txt`, `deployment/deployment-options.txt`, `deployment/compatibility-limitations.txt`, `crud-embeddings/automated-embedding*.txt`, and the matching includes. Published at https://www.mongodb.com/docs/vector-search/....

### 5.1 Availability and limits

| Tier | Vector Search | Search + vector index cap | Other limits relevant here |
|---|---|---|---|
| Free (formerly M0) | Yes. The docs list "Free cluster or higher" for testing. Runs MongoDB 8.0. | **3 indexes total** (search and vector combined) | 0.5 GB storage, 100 ops/s, 500 connections, 100 DBs / 500 collections, 50 aggregation stages, `allowDiskUse` ignored, 32 MB in-memory sort, `maxTimeMS` capped at 300 s, 10 GB in/out per 7 days, auto-pause after 30 idle days. |
| Flex | Yes (MongoDB 8.0+) | **10 indexes** | 5 GB, 500 ops/s, 500 connections, 100 DBs / 500 collections. |
| Dedicated M10+ | Yes; production advice is separate Search Nodes (S30+) | No fixed cap; "depends on tier and workload, start small" | |

- **Version and access requirements.** Vector index creation needs MongoDB 6.0.11 / 7.0.2+ (ENN needs 6.0.16 / 7.0.10 / 7.3.2+) and the Project Data Access Admin role.
- **Driver helpers work on all tiers.** In mongosh, `db.collection.getSearchIndexes()` is listed as unsupported on Free/Flex; use the driver helpers there.
- **Index build is asynchronous and eventually consistent.** `mongot` follows change streams. Poll `listSearchIndexes()` for `queryable: true`, and expect a short lag before new docs (for example, new "lessons") are searchable.

### 5.2 Vector index definition (bring-your-own embeddings) [V `code-snippets/syntax.js`]

```json
{
  "fields": [
    { "type": "vector", "path": "<field>", "numDimensions": 1024,
      "similarity": "euclidean | cosine | dotProduct",
      "quantization": "none | scalar | binary",
      "indexingMethod": "flat | hnsw",
      "hnswOptions": { "maxEdges": 16, "numEdgeCandidates": 100 } },
    { "type": "filter", "path": "<field>" }
  ],
  "nestedRoot": "<array-of-docs-field>",
  "storedSource": { "include": ["<field>"] }
}
```

Rules:
- `numDimensions` must be <= 8192. Binary quantization requires a multiple of 8.
- Similarity is required for `vector` fields.
- `quantization` defaults to `none`. `indexingMethod` defaults to `hnsw`. `maxEdges` ranges 16-64 (default 16) and `numEdgeCandidates` 100-3200 (default 100).
- `filter` fields support boolean, date, objectId, numeric, string and UUID values, including arrays of them.
- Voyage embeddings are normalized to length 1, so `dotProduct` and `cosine` are equivalent.

### 5.3 Automated embedding: `autoEmbed` field type (exists in 2026) [V `syntax-auto-embed.js`, `list-table-fields-auto-embed.rst`, `models.txt`]

```json
{
  "fields": [
    { "type": "autoEmbed", "modality": "text", "path": "<text-field>",
      "model": "voyage-4 | voyage-4-large | voyage-4-lite | voyage-code-4 | voyage-code-3",
      "numDimensions": 1024, "quantization": "scalar", "similarity": "dotProduct",
      "indexingMethod": "hnsw" },
    { "type": "filter", "path": "<field>" }
  ]
}
```

- **Required fields:** `type`, `modality` (`"text"`), `path` (the **text** field) and `model`. Optional: `numDimensions` (256/512/1024/2048, default 1024), `quantization` (`float`/`scalar`/`binary`/`binaryNoRescore`, default `scalar`), `similarity`, `indexingMethod`, `hnswOptions`, `nestedRoot`.
- **Status:** on Atlas it appears to be generally available. That is inferred: the docs show a Preview banner only on the self-managed variant, and the docs never say "GA". It is **Preview on self-managed Community 8.2+**.
- **Node driver:** >= 6.6.0 (the same as plain vector indexes).
- **Behaviour:**
  - Embeddings are generated at index time, on insert/update, and at query time.
  - They are stored in an internal database on your cluster, so plan for disk.
  - Text over 32k tokens is truncated at indexing.
  - A query over the context window fails with `context-limit-exceeded`.
- **Restrictions:**
  - **Cannot mix `vector` and `autoEmbed` fields in one index.**
  - `type` and `modality` are immutable after creation.
  - Dedicated clusters **must have storage auto-scaling**.
  - Inference runs in MongoDB's **GCP US region** (data leaves your cluster's region).
- **Pricing per 1M tokens:** voyage-4-large $0.12, voyage-4 $0.06, voyage-4-lite $0.02, voyage-code-4 $0.12, voyage-code-3 $0.18. There is a one-time 200M free tokens per model per org.
- **Query rate limits:** **Free cluster without a payment method: 3 RPM and 2,000 TPM per model.** M0 with a payment method, Flex and dedicated: 2,000 RPM and 3M-16M TPM. Index-build traffic has separate limits.

### 5.4 `$vectorSearch` stage [V `syntax.json`, `syntax-auto-embed.json`, field tables]

```js
// Bring-your-own vector
{ $vectorSearch: {
    index: "<index-name>", path: "<vector-field>", queryVector: [/* numbers */],
    numCandidates: 100,              // required unless exact:true; <= 10000; >= limit; ~20x limit recommended
    limit: 5,
    filter: { agentId: "a1", tags: { $in: ["sensor"] } },   // only fields indexed as type "filter"
    exact: false } }                 // true = ENN (omit numCandidates)
// autoEmbed index
{ $vectorSearch: { index: "<index>", path: "<text-field>", query: { text: "<query text>" },
    model: "voyage-4",               // optional; must be compatible with the index model
    numCandidates: 100, limit: 5, filter: { /* ... */ } } }
// score
{ $project: { embedding: 0, score: { $meta: "vectorSearchScore" } } }
```

- **Placement.** `$vectorSearch` must be the **first stage**. It is not allowed in view definitions, in `$lookup` sub-pipelines or in `$facet`; you can pass its results to a later `$lookup`.
- **Pre-filter operators:** `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$nor`, `$and`, `$or`.
- **Other options:** `parentFilter`, `nestedOptions.scoreMode`, `returnStoredSource`, `searchNodePreference`, `explainOptions`.
- **Docs inconsistency for autoEmbed.** A few autoEmbed snippets write `query: "<text>"` as a string. The reference table and MCP 3.0.5 use `query: { text }`; use the object form. [string form UNVERIFIED]

### 5.5 Create the index with the Node driver (6.6.0+; `createSearchIndex(description: SearchIndexDescription): Promise<string>`) [V typings in 6.21 and 7.7; compiled]

```ts
const lessons = db.collection("lessons");
const name = await lessons.createSearchIndex({
  name: "lessons_vector",
  type: "vectorSearch",
  definition: { fields: [
    { type: "vector", path: "embedding", numDimensions: 1024, similarity: "dotProduct" },
    { type: "filter", path: "agentId" },
    { type: "filter", path: "tags" },
  ] },
});
for (;;) {   // wait until queryable (doc pattern)
  const [idx] = (await lessons.listSearchIndexes(name).toArray()) as Array<{ name: string; status?: string; queryable?: boolean }>;
  if (idx?.queryable) break;
  await new Promise((r) => setTimeout(r, 5000));
}
// also: updateSearchIndex(name, definition), dropSearchIndex(name), createSearchIndexes([...])
```

The docs' own Node example is `content/vector-search/source/includes/index/vector-type/code-snippets/create-index/nodejs/filter-example.js`.

### 5.6 Embeddings: Voyage AI (MongoDB-owned) [V `content/voyageai/source/api-and-clients.txt`, `models/text-embeddings.txt`, `management/api-keys.txt`]

**Endpoint and authentication:**
- **Endpoint (Atlas):** `POST https://ai.mongodb.com/v1/embeddings` (rerank is `/v1/rerank`).
- **Header:** `Authorization: Bearer <model API key>` plus `Content-Type: application/json`.
- **Keys:**
  - Create a **model API key** in Atlas: project > Model API Keys > Create model API key. This needs Project Owner or Project Model Owner.
  - Keys created on the legacy Voyage platform only work against `https://api.voyageai.com/v1/embeddings`.
  - Geography-scoped keys use regional hosts such as `eu.ai.mongodb.com`.

**Request body:** `{ "input": ["..."], "model": "voyage-4", "input_type": "query" | "document", "output_dimension": 1024, "output_dtype": "float" }`. Constraints: at most 1,000 inputs per request; token caps are 320K for voyage-4 and 120K for voyage-4-large.

**Current text models:**

| Model | Context | Dimensions | Notes |
|---|---|---|---|
| `voyage-4-large` | 32k | 1024 (default), 256, 512, 2048 | Best quality. |
| `voyage-4` | 32k | 1024 (default), 256, 512, 2048 | Balanced, recommended. |
| `voyage-4-lite` | 32k | 1024 (default), 256, 512, 2048 | Latency and cost. |
| `voyage-code-4` | 32k | 1024 (default), 256, 512, 2048 | Code. |
| `voyage-finance-2` | 32k | 1024 | |
| `voyage-law-2` | 16k | 1024 | |
| `voyage-4-nano` | | 512 (default), 128, 256 | Open-weight. |

- The voyage-4 series embeddings are mutually compatible.
- Rerankers: `rerank-3` and `rerank-3-lite`.
- Tier 1 rate limits are 2,000 RPM; TPM is 3M for 4-large, 8M for 4 and 16M for 4-lite.
- Free trial tier: 200M free tokens per model. Its exact rate limits without a payment method were not found. [UNVERIFIED]

TypeScript client (`npm i voyageai`, 0.4.0). **You must set `environment` for Atlas keys**, because the default is `https://api.voyageai.com/v1` [V `environments.d.ts`; compiled]:

```ts
import { VoyageAIClient } from "voyageai";
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY, environment: "https://ai.mongodb.com/v1", maxRetries: 3 });
const r = await voyage.embed({ input: [text], model: "voyage-4", inputType: "query", outputDimension: 1024 });
const vec = r.data?.[0]?.embedding ?? [];
```

**Recommendation for MongoMation:**
- **Free/sandbox tier:** do client-side embeddings with `voyage-4` at 1024 dimensions and use `inputType` `"document"` / `"query"`. Avoid autoEmbed queries because of the 3 RPM cap without a payment method.
- **Flex/dedicated, or a payment method attached:** autoEmbed removes embedding code entirely.

---

## 6. Time series collections for sensor measurements

**Sources:** docs `content/manual/v8.0/source/core/timeseries/timeseries-granularity.txt`, `timeseries-limitations.txt`, `timeseries-best-practices.txt`, `timeseries-querying.txt`, `core/index-ttl.txt`; Atlas `atlas-ui/collections/time-series-collection.txt`; Node typings.

```ts
await db.createCollection("measurements", {
  timeseries: { timeField: "ts", metaField: "meta", granularity: "seconds" },   // TimeSeriesCollectionOptions [V typings]
  expireAfterSeconds: 30 * 24 * 3600,                                           // optional automatic removal
});
// custom bucketing (6.3+): set BOTH equal, and do not set granularity
// timeseries: { timeField: "ts", metaField: "meta", bucketMaxSpanSeconds: 3600, bucketRoundingSeconds: 3600 }  // 1-31536000
await db.collection("measurements").insertMany(batch, { ordered: false });   // batch grouped by meta value
```

**Configuration:**
- `timeField` must be a BSON date.
- `metaField` labels a series and should hold scalar sub-fields, for example `{ sensorId, deviceId, unit }`.
- `granularity` controls the bucket span: `seconds` = 1 hour, `minutes` = 24 hours, `hours` = 30 days. The default is `seconds`.
- Granularity or bucket spans can only be **increased** later, via `collMod`. `timeField` and `metaField` are immutable. You cannot convert a collection to or from time series.
- MongoDB 6.3+ automatically creates a secondary index on `metaField` + `timeField`.
- Since 7.0 you can add partial TTL indexes on `metaField` sub-fields.

**Limitations:**
- **No change streams** on time series collections.
- No Atlas Search or Vector Search, no schema validation, no `renameCollection`, no `reIndex`, no CSFLE, no Atlas Database Triggers.
- No **writes inside transactions** (reads are fine). No unique or text indexes.
- `$merge` cannot write into a time series collection (use `$out`). The maximum document size is 4 MB.
- Buckets hold at most 1,000 measurements or 125 KB.

**Free/Flex.** Time series is not listed among the Free or Flex unsupported features or commands, and Free/Flex run MongoDB 8.0. It should therefore be supported. [Inferred, UNVERIFIED: no explicit statement found. Smoke-test `createCollection` early.]

**Query tips (docs):**
- Filter on `metaField` scalar sub-fields (`"meta.sensorId": 5578`) rather than whole-object equality, plus a `ts` range.
- MongoDB 8.0 block processing speeds up pipelines that start with `$match`, `$sort` on `timeField`, or `$group`.
- Use window functions (`$setWindowFields`) for rolling stats.
- Write in batches with consistent field order and omit empty fields for better compression.
- For a live dashboard, keep a small regular `sensor_latest` collection (upsert per sensor) and **watch that**, or poll.

---

## 7. Node driver: version, change streams, job queue, TTL

### 7.1 Versions
- **Current major is 7** (7.7.0; Node >= 20.19.0). v7 breaking changes from the docs upgrade page:
  - Drops Node 16 and 18.
  - BSON 7.
  - Cursors no longer default `batchSize` to 1000.
  - Cursor and change-stream `transform` functions removed (use `stream().map()`).
  - `MONGODB-AWS` requires `@aws-sdk/credential-providers`.
  - Removed `useNewUrlParser`/`useUnifiedTopology`.
  - `watch()` accepts any `$changeStream` options.
- **Use 6.21.0 for this project** because of caveat C1. Every API below exists in both versions [V typings and compile against both].

### 7.2 Change streams (live dashboard push)
- **Availability:** replica sets and sharded clusters (all Atlas tiers are replica sets).
- **Free/Flex restriction:** a database-name (`ns`) filter may only use strings or regex, not `$in`. Collection-name filters are unrestricted.
- **Not on time series collections.**

```ts
const stream = db.collection("agent_events").watch(
  [{ $match: { operationType: { $in: ["insert", "update", "replace"] } } }],
  { fullDocument: "updateLookup", ...(savedToken ? { resumeAfter: savedToken } : {}) },   // or startAfter
);
for await (const change of stream) { push(change); savedToken = change._id; }   // persist the resume token
```

- Open **one** stream per server process and fan out to browsers over SSE or WebSocket. The Free tier allows 500 connections and 100 ops/s, and each stream issues periodic `getMore`s. [ops accounting UNVERIFIED]
- Handle a stale or invalid resume token by re-reading current state, then reopening without a token. [General guidance]

### 7.3 Job-queue leasing with `findOneAndUpdate`
This is a pattern built from documented primitives, not an official recipe; it compiled against 6.21 and 7.7.
- `returnDocument: "after"` (or `ReturnDocument.AFTER`) returns the updated document; the default is `"before"`.
- Since driver v6, `findOneAndUpdate` **returns the document, or `null`**, unless `includeResultMetadata: true`, which returns a `ModifyResult`.

```ts
// indexes: { status:1, priority:-1, runAt:1 } (claim), { status:1, leaseUntil:1 } (reaper), TTL { finishedAt:1 } expireAfterSeconds 7d
export async function claim(workerId: string, leaseMs = 60_000) {
  const now = new Date();
  return jobs.findOneAndUpdate(
    { status: "queued", runAt: { $lte: now } },
    { $set: { status: "leased", leaseOwner: workerId, leaseToken: randomUUID(), leaseUntil: new Date(now.getTime() + leaseMs) },
      $inc: { attempts: 1 } },
    { sort: { priority: -1, runAt: 1 }, returnDocument: "after" },
  );                                                     // WithId<Job> | null, atomic: only one worker wins
}
export const reap = () => jobs.updateMany(               // every ~15 s: return expired leases (crashed workers) to the queue
  { status: "leased", leaseUntil: { $lt: new Date() } },
  { $set: { status: "queued", leaseOwner: null, leaseToken: null, leaseUntil: null } });
export const heartbeat = (j: WithId<Job>, ms = 60_000) => jobs.updateOne(       // matchedCount 0 => lease lost, stop
  { _id: j._id, status: "leased", leaseToken: j.leaseToken }, { $set: { leaseUntil: new Date(Date.now() + ms) } });
export const complete = (j: WithId<Job>) => jobs.updateOne(                     // fenced by leaseToken
  { _id: j._id, status: "leased", leaseToken: j.leaseToken },
  { $set: { status: "succeeded", finishedAt: new Date(), leaseOwner: null, leaseToken: null, leaseUntil: null } });
```

- On failure, set `status:"queued"` with a backoff `runAt`. Once `attempts >= maxAttempts`, set `status:"dead"` with `finishedAt`.
- Store the LangGraph `thread_id` on the job. A reclaimed job then calls `graph.invoke(null, { configurable: { thread_id } })` to resume from its checkpoint (section 4.1).
- Make side-effecting nodes idempotent.
- The full compiled file is `scratchpad/tscheck/check4.ts`.

### 7.4 TTL indexes [V `core/index-ttl.txt`]
- Example: `createIndex({ finishedAt: 1 }, { expireAfterSeconds: 604800 })`. To expire at a specific clock time, use `createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })`.
- The field must be a date or an array of dates; arrays use the earliest date. Documents without the field never expire, which is useful for "only finished jobs expire".
- **Single-field only**: compound indexes ignore `expireAfterSeconds`. Not supported on `_id`. Change `expireAfterSeconds` with `collMod`, not `createIndex`.
- The background monitor runs **every 60 s** and only on the primary, so expiry is not immediate.

---

## 8. Top caveats for MongoMation

1. **C1: driver mismatch.** `@langchain/langgraph-checkpoint-mongodb@1.4.2` depends on `mongodb ^6.21.0`. A `mongodb@7` client fails TypeScript (verified). **Pin `mongodb@^6.21.0` app-wide.**
2. **MongoDB docs bug.** The `langgraph-js` overview shows `new MongoDBSaver(client)` and `compile(checkpointer)`. The correct calls are `new MongoDBSaver({ client, dbName })` and `compile({ checkpointer })`. Also, `setup()` returns `Error[]` instead of throwing.
3. **Free-tier limits.** If the hackathon sandbox is a Free cluster:
   - **Only 3 search/vector indexes in total.**
   - 0.5 GB of storage. Checkpoints write full state per super-step, so set `ttl` and/or call `deleteThread`.
   - 100 ops/s, so do not hot-poll the job queue; use backoff or a change-stream wake-up.
   - 500 connections.
   - **AutoEmbed queries are capped at 3 RPM without a payment method.**

   Check the cluster tier (`atlas-inspect-cluster` or the Atlas UI) on day one.
4. **MCP `--readOnly` hides `create-index`, `insert-many` and the other write tools.** To let Claude Code or Cursor create the vector index, run a second, non-read-only entry with `MDB_MCP_DISABLED_TOOLS=delete`. Better still, create indexes in an idempotent bootstrap script in code.
5. **Atlas-managed plugin and an org you don't own.** The plugin needs an Org Owner to enable AI clients (off by default). Programmatic MCP configs need Org or Project Owner. In a sandbox org you do not own, use the **local MCP server with a connection string**.
6. **`MongoDBStore` ignores `filter` when `query` is used (1.4.2).** Namespace prefixes are the only pre-filter, so post-filter results yourself or run your own `$vectorSearch`.
7. **Search indexes are asynchronous and eventually consistent.** Wait for `queryable`, and do not expect a lesson inserted a moment ago to be retrievable immediately. `$vectorSearch` must be the first pipeline stage, and its filter fields must be indexed as `type:"filter"`.
8. **Time series collections have no change streams, no transactional writes and no vector search.** Push live sensor data via a regular "latest" collection or by polling.
9. **Voyage key and endpoint must match.** Atlas model API keys work only on `https://ai.mongodb.com/v1`; the `voyageai` TS client defaults to `api.voyageai.com`, so set `environment`. Pick one model and dimension for both index and query (`voyage-4` at 1024). AutoEmbed indexes cannot mix `vector` fields, and their inference runs in GCP US.
10. **MCP version drift.**
    - Docs examples use `mongodb-mcp-server@latest` (3.x), while the repo's self-managed plugin pins `@<3`.
    - The docs tool table and the v3 tools differ: v3 adds `list-connections` and `disconnect` and has no `update-one` or `switch-connection`.
    - The MCP-side Voyage embedding described in the docs was not found in 3.0.5.

    Pin a version and audit it with `--dryRun`. MCP needs Node >= 22.13 on the Node 22 line.
11. **LangGraph durability.** Set `durability: "sync"` explicitly for crash recovery, because `"exit"` loses mid-run progress. Interrupted and retried nodes re-execute from their start, so make node side effects idempotent (for example, write a `jobId`-keyed outbox).
12. **Newer MongoDB products.** "MongoDB Atlas Agent Engine" (docs project `agentengine`, Public Preview, "not for production") and the Atlas Managed MCP are new in 2026 and not needed for this design. Treat them as optional.

## 9. Source index

- **MCP server:**
  - https://github.com/mongodb-js/mongodb-mcp-server (README)
  - https://www.npmjs.com/package/mongodb-mcp-server
  - https://www.mongodb.com/docs/mcp-server/get-started/
  - .../mcp-server/tools/
  - .../mcp-server/overview/
  - .../mcp-server/prerequisites/
  - .../mcp-server/remote-mcp/access-models/
  - .../mcp-server/remote-mcp/security/
  - .../mcp-server/remote-mcp/rate-limits/
  - Docs source: https://github.com/mongodb/docs/tree/main/content/mcp-server/source
- **Agent Skills:**
  - https://github.com/mongodb/agent-skills
  - https://www.mongodb.com/docs/agent-skills/
  - https://claude.com/plugins/mongodb-atlas
  - https://claude.com/plugins/mongodb
  - https://skills.sh/mongodb/agent-skills
- **LangGraph:**
  - https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-mongodb
  - https://www.npmjs.com/package/@langchain/langgraph-checkpoint-mongodb
  - https://github.com/langchain-ai/langchain-mongodb (Python)
  - https://docs.langchain.com/oss/langgraph/checkpointers
  - https://docs.langchain.com/oss/langgraph/fault-tolerance
  - https://docs.langchain.com/oss/langgraph/interrupts
  - https://docs.langchain.com/oss/javascript/integrations/memory/mongodb-short-term-memory
  - https://docs.langchain.com/oss/javascript/integrations/memory/mongodb-long-term-memory
  - https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/build-agents/
  - https://www.mongodb.com/docs/atlas/ai-integrations/langgraph-js/long-term-memory-store/
  - https://github.com/mongodb-developer/GenAI-Showcase
- **Vector Search:**
  - https://www.mongodb.com/docs/vector-search/indexes/vector-search-type/
  - .../vector-search/query/aggregation-stages/vector-search-stage/
  - .../vector-search/crud-embeddings/automated-embedding/
  - .../crud-embeddings/automated-embedding/models/
  - .../vector-search/deployment/deployment-options/
  - .../vector-search/deployment/compatibility-limitations/
- **Voyage:**
  - https://www.mongodb.com/docs/voyageai/api-and-clients/
  - .../voyageai/models/text-embeddings/
  - .../voyageai/management/api-keys/
  - API spec: https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/
- **Atlas limits:**
  - https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
  - .../atlas/reference/flex-limitations/
  - .../atlas/unsupported-commands/
- **Server manual:**
  - https://www.mongodb.com/docs/manual/core/timeseries/timeseries-granularity/
  - .../timeseries-limitations/
  - .../timeseries-best-practices/
  - .../core/index-ttl/
  - .../changeStreams/
- **Node driver:**
  - https://www.mongodb.com/docs/drivers/node/current/crud/compound-operations/
  - .../indexes/
  - .../monitoring-and-logging/change-streams/
  - .../reference/upgrade/
- **Claude Code MCP CLI:** https://code.claude.com/docs/en/mcp (plus local `claude mcp add --help`, v2.1.296).
- **Local verification artifacts** (scratchpad):
  - `tscheck/check*.ts`: compiled snippets
  - `tscheck7/`: driver 7.7 compile
  - `mcpdry/dry*.out`: MCP `--dryRun` tool lists
  - `dl/`: cloned sources
