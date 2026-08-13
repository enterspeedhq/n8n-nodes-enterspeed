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
npm link n8n-nodes-enterspeed
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

> **Note:** templates use the node type `CUSTOM.enterspeed`, which is the prefix n8n assigns when loading via `N8N_CUSTOM_EXTENSIONS` (the Docker path). If you load the package via `npm link` instead, your nodes will be registered as `n8n-nodes-enterspeed.enterspeed` and the imported template will show the nodes as unknown. Use the Docker setup when working with example workflows.

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
(v0.4.0). Before publishing: run in a local n8n against a real tenant, run
`npm run lint`, then `npm publish` and submit for n8n's verified-node program.

## Releasing

### Pre-release checklist

- [ ] Tested against a real Enterspeed tenant in a local n8n instance
- [ ] `npm run lint` passes with no errors
- [ ] `npm test` passes
- [ ] `npm run build` succeeds and `dist/` is populated
- [ ] `package.json` version is bumped appropriately (see below)

### Versioning

Follow [semver](https://semver.org):

| Change | Version bump |
|---|---|
| Bug fix, doc update | `patch` — e.g. `0.1.0` → `0.1.1` |
| New operation or node, backwards-compatible | `minor` — e.g. `0.1.0` → `0.2.0` |
| Breaking credential or API shape change | `major` — e.g. `0.1.0` → `1.0.0` |

### Release

Releasing is done with `@n8n/node-cli`'s release command, not manual
`npm publish` — n8n requires verified community nodes to be published via
GitHub Actions with an npm provenance attestation (mandatory from 1 May
2026), and a raw local `npm publish` can't produce that attestation.

```bash
npm run release
```

This lints, builds, prompts for a version bump, updates the changelog,
commits, tags, and pushes. The pushed tag (matching `*.*.*`) triggers
`.github/workflows/publish.yml` in CI, which runs `npm run release` again in
the Actions runner — this time it performs the actual `npm publish` with a
signed provenance attestation via GitHub's OIDC token.

After publishing, users who installed the package via n8n's Community Nodes UI
can update through **Settings → Community Nodes** once the new version is live
on npm (usually within a few minutes).

### Automated releases (GitHub Actions)

`.github/workflows/publish.yml` publishes to npm whenever a version tag
(`*.*.*`) is pushed. It requests `id-token: write` (to mint the OIDC token
for provenance) and `contents: read` — scoped down from the default write
permissions — then runs `npm run release` inside the job.

Authentication is one of:

- **OIDC Trusted Publishing (recommended)** — on npmjs.com, open the
  package's settings → **Publish access** → **Trusted Publishers** → add a
  GitHub Actions publisher pointing at this repo and workflow name
  `publish.yml`. No secret is needed; leave `NPM_TOKEN` unset.
- **`NPM_TOKEN` fallback** — a granular npm access token scoped to
  `n8n-nodes-enterspeed` with publish permission, added as a GitHub repo
  secret (**Settings → Secrets and variables → Actions**).

Either way, once the npm-side setup is done, `npm run release` (see above)
is the only manual step needed to ship a release.
