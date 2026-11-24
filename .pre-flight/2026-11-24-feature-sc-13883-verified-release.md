# feature/sc-13883/verified-release — 2026-11-24

## Changed files

- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`
- `AGENTS.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `README.md`
- `nodes/EnterspeedContextGraph/actions/entity/push.operation.ts`
- `nodes/EnterspeedContextGraph/actions/entity/pushMany.operation.ts`
- `package.json`

## Observations

The scan job and publish.yml only run once the stack reaches main, so neither has run in Actions yet; the first tagged release is the real end-to-end check of trusted publishing. Is that acceptable, or do we want a dry run first?

The main-ancestry check sits inside the workflow file the tag points at, so a tag on a branch with an edited publish.yml would still publish. The README now says so and suggests a tag ruleset; should that ruleset be part of this story?

CI triggers stay as they are (push to main, PRs into main), so a feature-branch push without a PR isn't scanned. The story says every push and pull request; is main plus every PR into main enough?
