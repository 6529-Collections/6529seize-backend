# Membership retirement record

The retired worker/dispatcher source templates and resolver have been removed.
Git history before this cleanup retains them for audit; they were never a
standalone recovery package. Recovery must use the exact deployed templates,
artifacts and private backups captured for the target environment.

See [the combined retirement runbook](../../../docs/membership-retirement.md) for
inventory, monitoring dependency removal, dispatcher-before-worker deletion,
explicit database cleanup, recovery and the separate production authorization.
Removing these source files does not itself delete any cloud or database object.
