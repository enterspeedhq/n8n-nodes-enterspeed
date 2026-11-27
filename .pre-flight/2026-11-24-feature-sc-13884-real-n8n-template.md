# feature/sc-13884/real-n8n-template — 2026-11-24

## Changed files

- `.github/workflows/ci.yml`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `README.md`
- `docker-compose.yml`
- `e2e/context-graph.mjs`
- `e2e/exports/complete/products.ndjson`
- `e2e/exports/malformed/products.ndjson`
- `e2e/package.json`
- `e2e/schema.mjs`
- `e2e/workflows/Context-Graph-E2E-Delivery-Reads.json`
- `nodes/EnterspeedContextGraph/actions/representation/get.operation.ts`
- `nodes/EnterspeedContextGraph/transport.ts`
- `scripts/execute-workflow.mjs`
- `scripts/setup.mjs`
- `tests/EnterspeedContextGraph.msd.test.ts`
- `tests/EnterspeedContextGraph.node.test.ts`
- `tests/mocks.ts`
- `tests/workflow-templates.test.ts`
- `workflows/templates/Context-Graph-Round-Trip.json`

## Observations

The e2e job pins @enterspeed/core and @enterspeed/dev-server 0.2.0-alpha.4, which isn't on npm yet; alpha.3 still serves only the unversioned ingest routes, so the round trip can't pass on it. Until alpha.4 is published the job's install step fails once this stack reaches main. Publish alpha.4 first, or hold the CI wiring until then?

Every Context Graph request now goes out with ignoreHttpStatusErrors and returnFullResponse, because n8n 2.27.4's own NodeApiError keeps only the status code. That fixes #36's retry and #38's 304 headers in a real n8n, but it lives here, above both. Should it move down onto #36?

The upload's unauthenticated PUT to the signed URL still goes through n8n's plain httpRequest, so a failed PUT likely keeps only its status in a real n8n too. It only uses the status today; is that enough?

No lockfile in e2e/, since it can't be generated before alpha.4 exists.
