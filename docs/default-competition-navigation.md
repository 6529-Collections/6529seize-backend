# Default competition read boundary

`GET /v3/waves/{wave_id}/default-competition` returns a nullable competition ID,
server evaluation time and nullable next refresh time in UTC milliseconds.
Wave and parent visibility run before selection; action groups do not hide
published readable competitions. Missing/unreadable waves return masked 404.

Only native competition configuration participates. Drafts, unpublished archives,
and cancelled records are excluded. Deleted-wave orphan machinery is removed
through the explicit cleanup procedure. Archived history
requires completion evidence. Active precedes upcoming, which precedes completed;
active/upcoming sort by earliest participation/voting start and completed by
latest recorded end. A null start is unbounded, a null end remains open. Equal
times use ascending immutable ID independent of collection pages or creation time.

Pending decisions retain active status after periods close; APPROVE remains
active until runtime completion. Native period ends are inclusive, so refresh
is end + 1 ms. Lifecycle/decision changes still invalidate selection independently
of that next scheduled refresh. Terminal lifecycle and recorded ended_at govern
completion; archive/update/cancellation times are not invented completion times.

The unpaginated projection reads only native selection columns using existing
competition indexes. It does not aggregate old wave decisions, hydrate entries or
consult obsolete wave competition columns. Choosing a sibling never repoints
permanent old GETs from the immutable original primary. See the
[runtime retirement](./competition-runtime-retirement.md).
