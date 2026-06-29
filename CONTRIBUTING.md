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

## Example workflows

The `workflows/templates/` directory contains example workflows. These are templates — they contain a credential placeholder and require `node scripts/setup.mjs` to be usable (see above).

The included `fetch-transform-reingest.json` is configured against the **N8N demo tenant** (`gid://Tenant/d6e26ed1-163f-48f4-88bb-3501ed45d9b5`). Ask the team for the API keys.

**Export a workflow to add a new template:**

1. Open the workflow in n8n
2. Menu → Download — saves a `.json` file
3. Strip personal/environment-specific fields before committing: `id`, `versionId`, `shared`, `creatorId`, `projectId`, `workflowId`, and any real credential IDs
4. Replace the credential ID with `__ENTERSPEED_CREDENTIAL_ID__`
5. Move it into `workflows/templates/` and commit it

> **Note:** templates use the node type `CUSTOM.enterspeed`, which is the prefix n8n assigns when loading via `N8N_CUSTOM_EXTENSIONS` (the Docker path). If you load the package via `npm link` instead, your nodes will be registered as `n8n-nodes-enterspeed.enterspeed` and the imported template will show the nodes as unknown. Use the Docker setup when working with example workflows.

## Branch and PR conventions

- Branch from `main`: `feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`
- Keep commits focused — one logical change per commit
- Run `npm run lint` and `npm test` before pushing
- Fill in the PR template; include which operations you tested and against which n8n version

## Adding a new operation

1. Add the operation value to the `operation` options array in `Enterspeed.node.ts` or `EnterspeedTrigger.node.ts`
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
