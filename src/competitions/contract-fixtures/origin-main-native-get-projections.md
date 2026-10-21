This test-only SQL mapping is frozen from backend commit `f3c959853`, source
`src/competitions/legacy-competition-get-facade.ts`, SHA-256
`c954319262071b5a50cc5415dd00b9658352242f00a985daaec7946acbe91800`.
The table expressions, fields, immutable ownership predicate and source-ownership
exceptions were extracted mechanically from that exact source. They must not be
regenerated from the implementation under test.

The adjacent fixture assembler reproduces the original installer's column and
collation discovery against the retained source schema. It installs twelve
separate comparison views in the disposable Jest database. The old permit
predicate remains literal SQL for exactness, with no permit rows; no retired
installer or execution module is imported. Both history streams are compared
directly against their retained physical observations because they were not
among the original twelve views.

The integration fixture populates every view, checks complete rows and primitive
types, null and empty values, original ownership against a selected sibling,
current and frozen votes, publication visibility, ordered awards, parentless
children, ordinary CHAT and DM defaults, shared orphan drop classifications,
and case/accent comparisons plus string column collations. The immutable Phase 0
fixtures in `phase-0/` remain unchanged.
