# Competition read boundary

All functioning competitions use native resources. Permanent old wave/drop GETs
remain native-backed projections of their immutable original primary; default
selection never changes that identity. Native-only sibling competitions are
excluded from the old competition contracts. Appearance inheritance still uses
shared wave metadata when a primary has no explicit native appearance.

Aggregate/voter score histories and scoped shared Activity logs are independent
native data. Readers do not consult migration checkpoints, audits, physical vote
mirrors or a legacy adapter. The old read/write/execution/hub/shadow flags are
retired. Per-competition lifecycle, execution mode, capabilities and authorization
remain enforced.

See [runtime retirement](./competition-runtime-retirement.md) for staged deployment,
parity and physical-absence acceptance. The immutable Phase 0 GET contract
fixtures are retained unchanged and must not be regenerated to accept a regression.
