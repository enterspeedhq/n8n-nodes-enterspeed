# feature/sc-10965/as-a-devops-engineer-i-want-n8n-nodes — 2026-08-17

## Changed files

.github/workflows/publish.yml
.eslintrc.js (deleted)
.prettierrc.js
AGENTS.md
ARCHITECTURE.md
CLAUDE.md
CONTRIBUTING.md
README.md
credentials/EnterspeedApi.credentials.ts
credentials/enterspeed.dark.svg
credentials/enterspeed.svg
eslint.config.mjs
gulpfile.js (deleted)
index.js (deleted)
nodes/Enterspeed/Enterspeed.node.ts
nodes/Enterspeed/EnterspeedTrigger.node.ts
nodes/Enterspeed/actions/delivery/index.ts
nodes/Enterspeed/actions/entity/delete.operation.ts
nodes/Enterspeed/actions/entity/deleteBulk.operation.ts
nodes/Enterspeed/actions/entity/index.ts
nodes/Enterspeed/actions/entity/shared.ts
nodes/Enterspeed/actions/query/index.ts
nodes/Enterspeed/actions/query/queryMulti.operation.ts
nodes/Enterspeed/actions/query/shared.ts
nodes/Enterspeed/actions/route/getAll.operation.ts
nodes/Enterspeed/actions/route/index.ts
nodes/Enterspeed/enterspeed.dark.svg
nodes/Enterspeed/webhookTrigger/handler.ts
nodes/Enterspeed/webhookTrigger/properties.ts
package-lock.json
package.json
tests/Enterspeed.node.test.ts
tests/mocks.ts
tsconfig.json

## Observations

1. Scope vs. the story: sc-10965's acceptance criteria describe wiring up the npm publish pipeline (`@n8n/node-cli`, a `release` script, `publish.yml`, CONTRIBUTING.md's Releasing section), but this branch also migrates build/lint tooling wholesale to `n8n-node`, renames the npm package, adds `webhookMethods`, switches to themed icons, and changes the delete-response shape. Is all of this meant to land in the same PR as sc-10965, or would splitting some of it out make review easier? Suppoes to be one PR 
2. Package rename: `package.json`/`README.md`/`CONTRIBUTING.md`/`AGENTS.md` rename the package from `n8n-nodes-enterspeed` to the scoped `@enterspeed/n8n-nodes-enterspeed`. Deliberate scoping decision, or should it stay unscoped to match the GitHub repo name (`enterspeedhq/n8n-nodes-enterspeed`) and the original story wording? Yes it is need to be renamed 
3. CHANGELOG.md untouched: the `[Unreleased]` section doesn't mention any of this PR's changes — the `deleted: true` merge behavior, the package rename, or the new publish pipeline — even though the project actively maintains this file. Worth adding entries before merge, or handled separately at release time? Add this if it is important 
4. tsconfig.json dropped `"types": ["node"]`: TypeScript now auto-includes every `@types/*` package pulled in transitively (via `@n8n/node-cli`'s own devDependencies, which brought in things like `@types/chai`, `@types/deep-eql`) instead of just Node's. Nothing fails today, but was narrowing the global type scope removed on purpose? Yes since it need to be configured to the n8n platform
