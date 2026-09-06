# Contributor agent instructions

## Prefer less code

Before adding code, consider whether the task can be solved by deleting,
simplifying, reusing, or combining existing code. Remove superseded paths when
consolidating behavior.

## Verification

- Fix the issue and run the smallest test that would have failed before the fix.
- Run `npm run build` before pushing to `master`.
- Use a boundary release suite only for broad or release-boundary changes:
  `test:release:frontend`, `test:release:backend`, or `test:release:desktop`.
- Deployment, rollback, capacity, soak, and browser sweeps are operator or
  flow-specific checks, not routine commit gates. See `docs/release-matrix.md`.

GitHub Actions is the only production deploy entrypoint. A push to the public
Fizzer repository's `master` branch deploys that exact revision through the
protected `production` environment. Self-hosters should use
`docs/self-hosting.md`; maintainer host identities and credentials stay outside
the repository.

## Compatibility names

The `CASCADE_*` environment variables, `~/.cascade` data directory, Elixir
`Cascade` modules, `cascade-*` helper commands, and some internal paths are
retained for compatibility. New user-facing text should use the Fizzer name;
do not mechanically rename compatibility identifiers without a migration plan.

## Iteration and delivery

- Share the smallest usable development preview as soon as its focused check
  passes. Include its location, tested revision and limitations; call it ready
  for feedback. A preview or completed worker task is not evidence of deployment.
- Keep handoffs to the outcome, essential constraints and artifact references.
  Use task steering for corrections to an existing worker's saved context;
  use child tasks only for independent pieces.
- Keep the assigned worker through implementation, verification and authorized
  delivery, including GitHub Actions and exact live checks. Bounded children
  return artifacts and checks to their integrating parent.
- Reuse recorded checks only for the same clean revision, command and relevant
  environment. Changed code or inputs invalidate that evidence. Live health and
  deployed revision must be checked again; a previous green workflow is not a
  current health check.
