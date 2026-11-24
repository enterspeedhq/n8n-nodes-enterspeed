# feature/sc-14248/enrichment-template — 2026-11-24

## Changed files

- `.env.example`
- `.github/workflows/ci.yml`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `README.md`
- `e2e/context-graph.mjs`
- `e2e/schema.mjs`
- `scripts/execute-workflow.mjs`
- `scripts/n8n-api.mjs`
- `scripts/setup.mjs`
- `workflows/templates/Context-Graph-Enrich-Changed-Products.json`

## Observations

The read-failure e2e case expects p-6 to be the read that gets the 503, which depends on the dev-server listing tags in key order. It is deterministic today; should it take the key from the proxy's 503 path instead?

The e2e unpublishes the enrichment workflow after its cases but doesn't check the response. If that fails, a later local run on the same n8n hits a webhook path clash with no hint why. Worth checking the status?

scripts/create-template.mjs still maps every credential to the Core placeholder, so exporting a template that uses the trigger or a chat model through it gives the wrong placeholder. That gap predates this branch (it already did so for the Context Graph credential). Fix it here or separately?

The e2e job pins @enterspeed/dev-server 0.2.0-alpha.4, which isn't on npm yet, so CI's e2e install fails until it is published. I ran it locally against a build of the SDK's master. Is that acceptable until the alpha ships?
