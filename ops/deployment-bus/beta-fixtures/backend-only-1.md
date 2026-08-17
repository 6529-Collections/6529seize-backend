# Release Bus v2 backend-only beta fixture 1

This file intentionally changes no runtime behavior. It gives the bounded
operator-only activation proof one exact green merge-tree while its explicit
deploy plan selects only the backend `api` unit. The proof exercises
non-force staging-ref advancement, an environment-bound artifact, manifest-
bound staging E2E, and a fresh production composition without redeploying an
unchanged frontend.

- Test ID: `backend-only-1`
- Prior historical candidate ID: `6549ea1d-5914-488b-b6f4-3e88cc7a222b`
- Activation cycle: `post-staging-ref-parity`
