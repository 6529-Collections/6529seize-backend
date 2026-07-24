# Release Bus v2 mixed retention/production-overlap independent backend fixture 2

This file intentionally changes no runtime behavior. It refreshes the
independent backend member of the bounded operator-only mixed acceptance train
after the frontend release-cache retention repair. Its deploy plan selects only
`attachmentsOrchestrator`, with no dependency on the coupled backend or
frontend members. That proves independent preparation and deployment, while
the three members share one exact manifest for the production-overlap beta.

- Test ID: `mixed-retention-prod-overlap-2`
- Candidate ID: `708657c1-3d9c-4e68-b0a9-6053017ddf52`
- Global Release Bus v2 mode: `OFF`
