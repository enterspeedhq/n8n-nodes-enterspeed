# chore/sc-14793/manifest-version — 2026-11-24

## Changed files

- `AGENTS.md`
- `docs/decisions/manifest-version.md`

## Observations

Docs only, so lint, test and build are unaffected; CI runs them only on PRs to main, so this stacked PR gets none until #41 lands.

The gap (no way for a Delivery-key client to find the current manifest) is a question for the platform, drafted in the PR body.
