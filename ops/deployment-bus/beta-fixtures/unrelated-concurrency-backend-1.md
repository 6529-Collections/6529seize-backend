# Release Bus v2 unrelated-concurrency backend beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only unrelated-concurrency acceptance test one exact green backend
merge-tree while its deploy plan selects only `attachmentsOrchestrator`.
The matching frontend candidate has no dependency on this candidate, allowing
the bus to prove independent preparation and deployment without supersession.

- Test ID: `mixed-retention-prod-overlap-2`
- Candidate ID: `708657c1-3d9c-4e68-b0a9-6053017ddf52`
- Global Release Bus v2 mode: `OFF`
