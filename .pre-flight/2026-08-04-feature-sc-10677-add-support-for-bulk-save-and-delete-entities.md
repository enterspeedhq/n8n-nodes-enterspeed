# feature/sc-10677/add-support-for-bulk-save-and-delete-entities — 2026-08-04

## Changed files

.gitignore
.mcp.template.json
AGENTS.md
ARCHITECTURE.md
CLAUDE.md
CONTRIBUTING.md
README.md
credentials/EnterspeedApi.credentials.ts
nodes/Enterspeed/Enterspeed.node.ts
nodes/Enterspeed/EnterspeedTrigger.node.ts
nodes/Enterspeed/actions/delivery/get.operation.ts
nodes/Enterspeed/actions/delivery/index.ts
nodes/Enterspeed/actions/entity/delete.operation.ts
nodes/Enterspeed/actions/entity/deleteBulk.operation.ts
nodes/Enterspeed/actions/entity/index.ts
nodes/Enterspeed/actions/entity/save.operation.ts
nodes/Enterspeed/actions/entity/saveBulk.operation.ts
nodes/Enterspeed/actions/entity/shared.ts
nodes/Enterspeed/actions/query/index.ts
nodes/Enterspeed/actions/query/query.operation.ts
nodes/Enterspeed/actions/query/queryMulti.operation.ts
nodes/Enterspeed/actions/query/shared.ts
nodes/Enterspeed/actions/route/getAll.operation.ts
nodes/Enterspeed/actions/route/index.ts
nodes/Enterspeed/actions/router.ts
nodes/Enterspeed/actions/types.ts
nodes/Enterspeed/enterspeed.svg
nodes/Enterspeed/transport.ts
nodes/Enterspeed/webhookTrigger/handler.ts
nodes/Enterspeed/webhookTrigger/properties.ts
package.json
scripts/create-template.mjs
scripts/setup.mjs
tests/Enterspeed.node.test.ts
tests/EnterspeedTrigger.node.test.ts
tests/mocks.ts
tests/workflow-templates.test.ts
workflows/templates/fetch-transform-reingest.json
workflows/templates/poll-index-for-changes.json

## Observations

None. README has been updated to document the bulk operations. Lint, tests, and build all pass cleanly. Workflow templates use the credential placeholder correctly.
