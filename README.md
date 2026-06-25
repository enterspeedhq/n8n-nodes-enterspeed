# n8n-nodes-enterspeed

[![CI](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml/badge.svg)](https://github.com/enterspeedhq/n8n-nodes-enterspeed/actions/workflows/ci.yml)

n8n community nodes for [Enterspeed](https://www.enterspeed.com) — get data **into** Enterspeed and feeds **out** of it, then wire it to any of n8n's 1,100+ destinations.

This package ships two nodes:

- **Enterspeed** (action) — Ingest, Delivery, Query and Routes operations.
- **Enterspeed Trigger** (polling) — starts a workflow when items in an index change.

No keys are bundled. The customer enters their own Enterspeed credentials at runtime.

## Installation

In n8n: **Settings → Community Nodes → Install** and enter `n8n-nodes-enterspeed`.

Self-hosted via npm:

```bash
npm install n8n-nodes-enterspeed
```

## Credentials

Create an **Enterspeed API** credential with:

| Field | Where to get it | Used by |
|---|---|---|
| Environment API Key | Settings → Environment settings | Delivery, Query, Routes |
| Source API Key | Settings → Data sources | Ingest |
| Hosts | pre-filled with public endpoints | override for dedicated tenants |

## Operations

**Entity (Ingest)** — `POST/DELETE https://api.enterspeed.com/ingest/v2/{originId}`
- *Save*: requires Origin ID, Entity Type (immutable after first ingest) and a JSON body.
- *Delete*: requires Origin ID.

**Delivery — Get Content** — `GET https://delivery.enterspeed.com/v2`
- Fetch by URL, comma-separated view IDs, and/or handles.

**Query — Query Index** — `POST https://query.enterspeed.com/v1/{indexAlias}`
- Pass a JSON body with `filters`, `sort`, `pagination`, `facets` (all optional).

**Route — Get Many** — `GET https://api.enterspeed.com/routes/v1`
- Page size 100–500.

## Trigger (polling)

Enterspeed builds views at publish time and does not push outbound webhooks, so
the trigger polls a Query index on a schedule and emits items that are new or
changed since the last run. The first run sets a baseline (no flood) unless
*Emit On First Poll* is enabled. Change detection uses a configurable marker
field (e.g. `updatedAt`) and ID field.

## Typical flows

- **Ingest**: Source (PIM/CMS/ERP) → map → **Enterspeed: Save Entity**.
- **Delivery / last mile**: **Enterspeed Trigger** → map to feed (XML/CSV) → push to Google / Meta / marketplace.

## Build from source

```bash
npm install
npm run build      # tsc + copies icons to dist
npm run lint       # n8n community-node linter
```

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

### Manual release

```bash
# 1. Bump version, commit, and tag in one step
npm version patch   # or minor / major

# 2. Build
npm run build

# 3. Publish to npm (requires npm login with an account that has publish access)
npm publish --access public

# 4. Push the version commit and tag to GitHub
git push --follow-tags
```

After publishing, users who installed the package via n8n's Community Nodes UI
can update through **Settings → Community Nodes** once the new version is live
on npm (usually within a few minutes).

### Automated releases (GitHub Actions)

When the project is ready for automated CD, the following two-workflow setup
covers CI on every push/PR and publishes to npm on version tags:

**`.github/workflows/ci.yml`** — runs on every push and pull request to `main`:

```yaml
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

**`.github/workflows/release.yml`** — triggered by pushing a version tag (`v*`):

```yaml
on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm test
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

Add an `NPM_TOKEN` secret in GitHub repo **Settings → Secrets → Actions** — a
granular npm access token scoped to `n8n-nodes-enterspeed` with publish
permission. With this in place, `git push --follow-tags` is the only manual
step needed to ship a release.

## Licence

MIT © Enterspeed A/S
