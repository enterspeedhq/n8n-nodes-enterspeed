# feature/sc-14302/index-query-return-all — 2026-11-24

## Changed files

- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `README.md`
- `docs/context-graph-demo/GUIDE.md`
- `nodes/EnterspeedContextGraph/actions/index/query.operation.ts`
- `tests/EnterspeedContextGraph.node.test.ts`

## Observations

The merged result keeps the first page's totalCount. A later page with failed shards answers totalCount null, so the merged output could look complete while missing matches. Should Return All fail the query, or null totalCount, when a later page says null?

A JSON query with "page": "0" as a string fails the page check, though a cursor would override it. It fails safe; is it worth accepting numeric strings?

The dev-server answers a batch with repeated ids 200, so on it two queries sharing an id share one answer and would walk together. That isn't new with Return All; is the node's own duplicate check worth running on unsplit runs too?

No test covers a follow-up query that grows past the body limit with its cursor, nor a split later round where only one request fails. The code reads right; should they get tests?
