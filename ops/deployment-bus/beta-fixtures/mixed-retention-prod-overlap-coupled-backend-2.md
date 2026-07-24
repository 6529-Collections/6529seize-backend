# Release Bus v2 mixed retention/production-overlap coupled backend fixture 2

This file intentionally changes no runtime behavior. It refreshes the coupled
backend member of the bounded operator-only mixed acceptance train after the
frontend release-cache retention repair. The deploy plan selects
`dbMigrationsLoop`, `attachmentsProcessor`, and `api`, with
`dbMigrationsLoop` required before `api`; `attachmentsProcessor` remains
eligible for the first concurrent DAG frontier. Together with the matching
frontend and independent-backend members, the train also creates one exact
three-candidate manifest for the production-overlap beta.

- Test ID: `mixed-retention-prod-overlap-2`
- Candidate ID: `022b5a1d-6449-495a-962a-4f16b0b046a8`
- Global Release Bus v2 mode: `OFF`
