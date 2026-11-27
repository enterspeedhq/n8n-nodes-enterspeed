# Contributing

Thanks for your interest in contributing to `n8n-nodes-enterspeed`.

## Prerequisites

- Node.js 20 (see `.nvmrc` — use `nvm use` to switch automatically)
- A local [n8n](https://docs.n8n.io/hosting/installation/npm/) instance for end-to-end testing
- An Enterspeed account with at least one environment

## Local setup

```bash
git clone https://github.com/enterspeedhq/n8n-nodes-enterspeed.git
cd n8n-nodes-enterspeed
npm install
```

## Development workflow

```bash
npm run build       # compile TypeScript + copy icons to dist/
npm run dev         # watch mode — recompiles on save
npm run lint        # n8n community-node linter
npm test            # Vitest unit tests
```

## Testing against a real n8n instance

The fastest way is to `npm link` the package into a local n8n installation:

```bash
# In this repo
npm run build
npm link

# In your n8n directory (e.g. ~/.n8n)
npm link @enterspeed/n8n-nodes-enterspeed
```

Then restart n8n — the Enterspeed nodes will appear in the palette. Test each operation against a real Enterspeed environment before opening a PR.

## Testing with Docker

If you'd rather not install n8n globally, you can spin up a local instance with Docker Compose. A `docker-compose.yml` is included in the repo. Before starting, copy the example env file:

```bash
cp .env.example .env
# Fill in N8N_ENCRYPTION_KEY (any random string) and the Enterspeed API keys
```

Then:

```bash
npm run build           # compile to dist/
docker compose up -d    # start n8n at http://localhost:5678
```

Once n8n is running, run the setup script to create the credential and import all example workflows in one step:

```bash
node scripts/setup.mjs
```

The script creates the `Enterspeed account` credential from your `.env` values, substitutes the credential ID into the workflow templates in memory, and imports them — the template files on disk are never modified.

After changing code:

```bash
npm run build && docker compose restart n8n
```

### The Context Graph end to end

CI runs the round-trip template (`Context-Graph-Round-Trip.json`) in this Docker n8n against the SDK dev-server, with an empty graph, on every pull request into `main`. To run it locally you need Node 26 (the dev-server's minimum):

```bash
cd e2e && npm install && cd ..   # the dev-server version pinned in e2e/package.json
N8N_WORKFLOW_DIRS=workflows/templates,e2e/workflows node scripts/setup.mjs
node e2e/context-graph.mjs
```

It starts the dev-server (graph on `:5200`), serves the export the template fetches (`:5500`), runs each case with `scripts/execute-workflow.mjs` and checks what each node output, then stops. `node e2e/context-graph.mjs --serve` only serves the graph and the export, for running the template by hand. On Linux the n8n container reaches the host through `host.docker.internal`, which `docker-compose.yml` maps.

Until the pinned dev-server version is published, install it from a build of the Context Graph SDK's `master` instead: `pnpm pack` its `core` and `dev-server` packages, then `npm install --no-save <core.tgz> <dev-server.tgz>` in `e2e/`.

## Connecting an MCP client to your local n8n

Once your local n8n instance is running (see above), you can let an MCP-capable
client (Claude Code, Codex CLI, etc.) browse and manage it directly:

1. In n8n: **Settings → Instance-level MCP** → toggle **Enable MCP access**
   (requires the instance owner or an admin).
2. Click **Connection details** → **Access Token** tab. Copy the instance URL
   and the personal MCP access token — the token is only shown in full once,
   so grab it now.
3. Copy `.mcp.template.json` to `.mcp.json` and paste the token into the
   `Authorization` header:

   ```bash
   cp .mcp.template.json .mcp.json
   ```

`.mcp.json` is gitignored — never commit your token. See [n8n's MCP server
docs](https://docs.n8n.io/connect/connect-to-n8n-mcp-server) for connecting
other clients (e.g. Codex CLI's `~/.codex/config.toml`).

## Example workflows

The `workflows/templates/` directory contains example workflows. These are templates — they contain a credential placeholder and require `node scripts/setup.mjs` to be usable (see above).

The included `fetch-transform-reingest.json` is configured against the **N8N demo tenant** (`gid://Tenant/d6e26ed1-163f-48f4-88bb-3501ed45d9b5`). Ask the team for the API keys.

**Export a workflow to add a new template:**

Build and test the workflow in your local Docker n8n, then run:

```bash
node scripts/create-template.mjs --name "Your Workflow Name"
```

This exports it from the running container, strips every personal/
environment-specific field (`id`, `versionId`, `shared`, `staticData`, `tags`,
etc. — anything not in the template's fixed field set), forces `active` to
`false`, and replaces every node credential's ID with
`__ENTERSPEED_CREDENTIAL_ID__`. It writes the result straight into
`workflows/templates/<kebab-case-name>.json` — run `npm test` afterwards to
confirm it passes `tests/workflow-templates.test.ts`, then commit it.

Pass `--id <workflowId>` instead of `--name` to disambiguate workflows with
the same name, `--out <filename>.json` to control the output filename, or
`--file <path>` to sanitize a `.json` file downloaded via the n8n UI's
Menu → Download instead of pulling from Docker.

> **Note:** templates use the node types `CUSTOM.enterspeed` and `CUSTOM.enterspeedContextGraph`, with the prefix n8n assigns when loading via `N8N_CUSTOM_EXTENSIONS` (the Docker path). If you load the package via `npm link` instead, your nodes will be registered as `@enterspeed/n8n-nodes-enterspeed.enterspeed` and the imported template will show the nodes as unknown. Use the Docker setup when working with example workflows.

## Branch and PR conventions

- Branch from `main`: `feature/<short-description>`, `fix/<short-description>`, `chore/<short-description>`
- Keep commits focused — one logical change per commit
- Run `npm run lint` and `npm test` before pushing
- Fill in the PR template; include which operations you tested and against which n8n version

## Adding a new operation

1. Add the operation value to the `operation` options array in `Enterspeed.node.ts`
2. Add any new input fields, gated by `displayOptions.show.operation`
3. Handle the new operation in the `execute` method
4. Add at least one unit test in `tests/`
5. Update `README.md` under **Operations**

## Credentials

The `EnterspeedApi` credential type lives in `credentials/EnterspeedApi.credentials.ts`. If you need to add a new field (e.g. a new host override), add it there and update the relevant operation in the node.

## Code style

ESLint is configured with `eslint-plugin-n8n-nodes-base`. Run `npm run lintfix` to auto-fix what it can. The key rules to be aware of:

- Node display names must match the file name convention
- Every parameter must have a `description` field
- `executeWithRetry` is preferred over manual retry loops

## Status & next steps

Starter implementation, verified against the public Enterspeed OpenAPI spec
(v0.4.0). Before a release: run in a local n8n against a real tenant, run
`npm run lint` and `npm run scan`, then release as below and submit for n8n's
verified-node program.

## Releasing

### Pre-release checklist

- [ ] Tested against a real Enterspeed tenant in a local n8n instance
- [ ] `npm run lint` passes with no errors
- [ ] `npm test` passes
- [ ] `npm run build` succeeds and `dist/` is populated
- [ ] `npm run scan` passes (n8n's community package scanner)
- [ ] `package.json` version is bumped appropriately (see below)

### Versioning

Follow [semver](https://semver.org):

| Change | Version bump |
|---|---|
| Bug fix, doc update | `patch` — e.g. `0.1.0` → `0.1.1` |
| New operation or node, backwards-compatible | `minor` — e.g. `0.1.0` → `0.2.0` |
| Breaking credential or API shape change | `major` — e.g. `0.1.0` → `1.0.0` |

### Release

Run `npm run build && npm run scan` first: it runs n8n's community package
scanner on the files `npm publish` would ship, as CI does on every pull
request into `main`. Then, on an up-to-date `main`:

```bash
npm run release
```

This lints, builds, prompts for a version bump, updates the changelog,
commits, tags (the bare version, e.g. `0.2.0`) and pushes. It doesn't publish.
The tag starts `.github/workflows/publish.yml`, which checks the tag equals
`package.json`'s version and is on `main`, runs the tests and the build, packs
the tarball, runs the scanner, and publishes that tarball with a provenance
statement from a job that installs nothing. npm publishes only from that workflow: never run
`npm publish` or `npm run release -- --publish` from your machine.

After publishing, users who installed the package via n8n's Community Nodes UI
can update through **Settings → Community Nodes** once the new version is live
on npm (usually within a few minutes).

### Publishing setup (npm trusted publishing)

The workflow requests `id-token: write` and `contents: read` and stores no npm
token: npm exchanges the job's GitHub OIDC token for a short-lived publish
token. The one-time setup on npmjs.com is in the README's
[Releasing](README.md#releasing) section: register `publish.yml` as the
package's trusted publisher, disallow tokens, and revoke any old one.
