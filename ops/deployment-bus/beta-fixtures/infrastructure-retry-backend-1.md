# Release Bus v2 infrastructure-retry backend beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only infrastructure-retry acceptance test one exact green backend
merge-tree. The deploy plan selects only `api`; the matching one-shot beta
configuration injects an infrastructure failure into
`PREPARE_ARTIFACT_BACKEND` before dispatch, then requires the same operation to
retry idempotently and deploy without candidate isolation or duplicate work.

- Test ID: `infrastructure-retry-1`
- Candidate ID: `91a20f74-230b-4e66-9e1b-308930523c13`
- Global Release Bus v2 mode: `OFF`
