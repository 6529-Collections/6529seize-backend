# Release Bus v2 coupled DAG backend beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only coupled staging acceptance test one exact green backend
merge-tree. The deploy plan selects `dbMigrationsLoop`, `attachmentsProcessor`,
and `api`, with `dbMigrationsLoop` required before `api`; the unrelated
`attachmentsProcessor` unit remains eligible for the first concurrent DAG
frontier.

- Test ID: `mixed-retention-prod-overlap-2`
- Candidate ID: `022b5a1d-6449-495a-962a-4f16b0b046a8`
- Global Release Bus v2 mode: `OFF`
