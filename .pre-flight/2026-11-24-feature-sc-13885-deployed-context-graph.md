# feature/sc-13885/deployed-context-graph — 2026-11-24

## Changed files

- `.github/workflows/ci.yml`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CLAUDE.md`
- `CONTRIBUTING.md`
- `README.md`
- `credentials/EnterspeedContextGraphApi.credentials.ts`
- `e2e/context-graph.mjs`
- `nodes/EnterspeedContextGraph/actions/artifact/shared.ts`
- `nodes/EnterspeedContextGraph/actions/entity/shared.ts`
- `scripts/execute-workflow.mjs`
- `tests/EnterspeedContextGraph.node.test.ts`
- `workflows/templates/Context-Graph-Round-Trip.json`

## Observations

Push words every whole-request 403 as a key without write scope or an unlisted address, because it never read a 403's body; the artifact operations keep a problem body's own title. Should Push read the problem body on a 403 too, now that the wording names two causes?

The 403 wording assumes a deployed Ingest URL's address list answers a bare 403. I couldn't check that without the Beta stack; is it worth confirming on the first manual run before the release?
