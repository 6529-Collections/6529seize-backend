# Release Bus v2 unrelated-concurrency backend beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only unrelated-concurrency acceptance test one exact green backend
merge-tree while its deploy plan selects only `attachmentsOrchestrator`.
The matching frontend candidate has no dependency on this candidate, allowing
the bus to prove independent preparation and deployment without supersession.

- Test ID: `unrelated-concurrency-1`
- Candidate ID: `71726b04-49ca-45ec-b13c-20b16fee714b`
- Global Release Bus v2 mode: `OFF`
