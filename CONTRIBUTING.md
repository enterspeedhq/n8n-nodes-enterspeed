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
# edit .env and set N8N_ENCRYPTION_KEY to any random string
```

Then:

```bash
npm run build           # compile to dist/
docker compose up       # open http://localhost:5678
```

The `dist/` directory is mounted directly into n8n's custom-extensions path, so n8n picks up the nodes on startup. After changing code:

```bash
npm run build && docker compose restart n8n
```

## Example workflows

The `workflows/` directory contains example n8n workflows you can import to try the nodes against a real Enterspeed environment.

**Import a workflow:**

```bash
# Via the n8n UI: Menu → Import from file → select a .json from workflows/
```

**Export a workflow to share it:**

1. Open the workflow in n8n
2. Menu → Download — saves a `.json` file
3. Move it into `workflows/` and commit it

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
