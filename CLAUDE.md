@AGENTS.md
@ARCHITECTURE.md

# CLAUDE.md

Claude-specific shortcuts for this repo. Universal conventions and
boundaries are in the imported `AGENTS.md`; technical detail is in the
imported `ARCHITECTURE.md`.

## Commands

```bash
npm run build        # n8n-node build
npm run build:watch   # tsc --watch (typecheck only, no asset copy)
npm run dev           # n8n-node dev
npm run lint          # n8n-node lint (eslint.config.mjs, @n8n/eslint-plugin-community-nodes)
npm run lint:fix      # n8n-node lint --fix
npm test              # vitest run
npm run test:watch    # vitest watch mode
```

`n8n-node build`/`dev` copy every `**/*.{png,svg}` in the source tree into
`dist/` at the same relative path. The node's icon lives at
`nodes/Enterspeed/enterspeed.svg`; the `EnterspeedApi` credential reuses the
same artwork but needs its own copy at `credentials/enterspeed.svg`, since
each `icon: 'file:...'` reference resolves relative to the compiled file
that declares it. Keep both files identical if the icon ever changes — there
used to be a `gulpfile.js` step for this, but the plain glob-copy makes it
unnecessary.

Docker end-to-end flow (not npm-wired, run manually):

```bash
docker compose up -d
node scripts/setup.mjs             # creates credential, imports workflows/templates/*.json
node scripts/execute-workflow.mjs  # triggers a workflow by name (N8N_WORKFLOW_NAME env var)
```

## Code style

- Tabs for indentation, single quotes.
- Type-only imports use `import type { ... } from 'n8n-workflow'`, kept
  separate from value imports.
- One operation = one `*.operation.ts` file exporting `properties:
  INodeProperties[]` and `execute(this: IExecuteFunctions, itemIndex:
  number, creds: EnterspeedCredentials): Promise<INodeExecutionData[]>`.
- Node/credential class names are PascalCase and match their file's base
  name (e.g. `EnterspeedTrigger` in `EnterspeedTrigger.node.ts`).
- Shared field-builders and payload assembly for a resource live in that
  resource's `shared.ts`, not duplicated per operation.

## Claude tool preferences

- Prefer the Edit/Write tools for file changes over shell redirection.
- Reserve Bash for build/lint/test/docker commands.
- Treat `docker compose`, `npm publish`, and `git push --follow-tags` as
  requiring explicit confirmation before running — don't chain them into an
  automated fix-verify loop.
- When adding or changing a workflow template under `workflows/templates/`,
  always re-check it against the rules in `AGENTS.md` (placeholder
  credential ID, `CUSTOM.enterspeed` node type) before considering the
  change done — `tests/workflow-templates.test.ts` will fail loudly but it's
  faster to get it right first.
