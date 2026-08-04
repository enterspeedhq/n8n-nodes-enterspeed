# feature/sc-10120/e2e-ci-pipeline-for-n8n-nodes-enterspeed — 2026-07-28

Story: sc-10120 — E2E CI pipeline for n8n-nodes-enterspeed

## Changed files

nodes/Enterspeed/Enterspeed.node.ts
scripts/setup.mjs
workflows/templates/fetch-transform-reingest.json

## Observations

The GitHub Actions pipeline itself (secrets injection, non-prod guard) isn't in this diff — by the developer's own account, that piece can only be built and tested on GitHub directly, so it's deferred rather than missing. Worth a follow-up PR once this groundwork lands, or is it being done in the same branch later?