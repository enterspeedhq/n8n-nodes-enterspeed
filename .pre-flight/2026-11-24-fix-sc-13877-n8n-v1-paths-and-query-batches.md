# fix/sc-13877/n8n-v1-paths-and-query-batches — 2026-11-24

## Changed files

- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `nodes/EnterspeedContextGraph/actions/artifact/shared.ts`
- `nodes/EnterspeedContextGraph/actions/entity/push.operation.ts`
- `nodes/EnterspeedContextGraph/actions/entity/pushMany.operation.ts`
- `nodes/EnterspeedContextGraph/actions/entity/shared.ts`
- `nodes/EnterspeedContextGraph/actions/index/query.operation.ts`
- `tests/EnterspeedContextGraph.node.test.ts`

## Observations

Verified every change against semantic-graph origin/main (1bc526bc6): ingest maps all routes under /v1 (IngestWriteExtensions.cs:205, ArtifactEndpoints.cs), write cap 32 MiB (WriteCapOptions.cs:33), /query body limit 32 KiB (QueryEndpoints.cs:62), 503/500 problem bodies (QueryEndpoints.cs:952,966), delivery 400s are plain strings so reading detail leaves them unchanged.

Lint, build and 300 tests green on Node 20.19, 22.16 and 24.21. CI e2e cannot run: ci.yml runs only on PRs into main, and this PR targets #33's branch.

Published dev-server alpha.3 still serves unversioned ingest routes, so Push/Upload 404 against it until the next alpha; documented.
