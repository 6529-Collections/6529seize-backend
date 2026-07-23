# Release Bus v2 coupled DAG backend beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only coupled staging acceptance test one exact green backend
merge-tree. The deploy plan selects `dbMigrationsLoop`, `attachmentsProcessor`,
and `api`, with `dbMigrationsLoop` required before `api`; the unrelated
`attachmentsProcessor` unit remains eligible for the first concurrent DAG
frontier.

- Test ID: `coupled-dag-1`
- Candidate ID: `70024a48-7130-43ed-b2c9-9fb0347479c5`
- Global Release Bus v2 mode: `OFF`
