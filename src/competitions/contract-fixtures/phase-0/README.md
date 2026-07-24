# Phase 0 permanent GET contract locks

These three files are byte-for-byte copies of the accepted Phase 0 evidence in
`6529seize-frontend/ops/roadmap/waves-multi-competition/phase-0/baseline`.
They are deliberately stored at the backend enforcement boundary so backend CI
does not depend on a sibling checkout. Do not regenerate or relax them when an
implementation changes; update them only through a separately accepted
compatibility decision.

- OpenAPI snapshot: 183 permanent GET operations and their reachable schemas.
- Runtime route manifest: 296 permanent mounted GET route shapes.
- Representative fixtures: synthetic legacy/native mapping, pagination, and
  masked-error cases.

## Accepted retirements

The Simple Release Bus V1 operational GET routes are retired by the accepted
V1-removal decision in backend PR #1831. The immutable baseline remains
byte-for-byte intact for auditability; the runtime census excludes only these
four authenticated operational routes:

- `/deploy/release-bus/controls`
- `/deploy/release-candidates`
- `/deploy/release-trains`
- `/deploy/release-trains/:id`
