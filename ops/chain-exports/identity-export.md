# Identity export job

The identity export (`6529 run identity:export`) also runs as a job of the
`dbDumpsDaily` function. It follows the rules in [README.md](README.md):

- it reads the read replica only;
- it writes the owned private bucket only, naming the expected owner on
  every call and sending a SHA-256 checksum with every upload;
- it writes the manifest last.

Invoke it as the README says: AWS CLI v2, always `--region`, the event in a
file passed as `file://event.json`, and `AWS_MAX_ATTEMPTS` set to 1 so the
CLI never starts a second run after a timeout.

The event carries the CLI's options, under the same rules.

## The event

- `job`: `identityExport`.
- `freezeAt` (`--freeze-at`), or `noFreeze: true` (`--no-freeze`) for a
  rehearsal: 00:00 UTC, as ISO UTC (`2026-11-24T00:00:00Z`) or 13-digit Unix
  milliseconds. At the freeze, 6529.io's `IDENTITY_FREEZE_AT` must be set to
  the same time.
- `expectTdhBlock` (`--expect-tdh-block`): required with `freezeAt`.
- `revision` (`--revision`), optional. The function knows the commit it was
  built from and writes that one; a `revision` given must be that commit.
  Give it only when the function's build doesn't record its commit; the run
  then says so.
- `extraIds` (`--extra-ids`), or `noExtraIds: true` (`--no-extra-ids`):
  `{ "key": "<object key>" }` or `{ "inline": [...] }`, profile ids (UUIDs).
  At the freeze, `noExtraIds` needs `acceptNoExtraIds: true`.
- `cmsFields` (`--cms-fields`), or `noCmsFields: true` (`--no-cms-fields`):
  a rehearsal only, `{ "key": "<object key>" }` or `{ "inline": {...} }`. At
  the freeze leave both out: see below.
- `bulk` (`--bulk`): default 2000. At the freeze, another number needs
  `acceptBulk` with the same number.
- `noDelegations: true` (`--no-delegations`): a rehearsal only.
- `acceptOverCredit`, `acceptEditsAfterFreeze`,
  `acceptRatingsChangedAfterFreeze`, `acceptProfileWritesAfterFreeze`,
  `acceptMissingExtraIds`, `acceptUnmatchedCms` (`--accept-*`): each the
  exact count a refused run reported. Only with `expectTdhBlock`.
- `acceptConsolidationsAfterFreeze` (`--accept-consolidations-after-freeze`):
  at most this many consolidations and primary-address delegations after the
  TDH block (below). A ceiling, not an exact count: give the count a refused
  run reported, or a little more if more may come before the next run.
- `acceptSnapshotGapMinutes`: at the freeze, accepts a snapshot more than 90
  minutes after it.
- `acceptUnknownReplicaLag: true`: at the freeze, run although the replica's
  lag can't be read, relying on the 2-minute gap alone. Only when Monday
  showed the lag can't be read, and the identity lead agreed. The manifest
  records it.
- `replacePointer: true`: at the freeze, makes this run the freeze's export
  when another run already is.

Unknown fields are refused. A refusal names these event fields, as you give
them (`"acceptOverCredit": 3`); the CLI's refusals name its flags.

In a rehearsal an input's key must be an object in the chain exports bucket,
under one of two prefixes:

- `identity-export/`, for the waves list you put there;
- `profile-site-export/`, for a profile site export run's
  `cms-fields.json`.

An inline input is hashed as its JSON text.

### The profile site values at the freeze

At the freeze the job takes the profile site values only from the profile
site export of the same freeze and stage. It reads that job's pointer,
`profile-site-export/<stage>/by-freeze/<freezeAt>.json`, then the run it
names. It refuses, before reading the database, unless:

- the pointer is for this freeze, and names a run of this stage and that
  run's `manifest.json`;
- the manifest has the sha256 the pointer records;
- the manifest is of a whole, usable run (`usable` true, not a rehearsal)
  of this freeze and stage;
- the manifest lists `cms-fields.json` with the sha256 of the file read.

A site export with no sites writes `{}`. That file is taken (no identity
gets a value), and the file's notes say so.

The export's header (`cms_fields.manifest`) and the manifest
(`cms_fields_source`) record the site manifest's key and sha256. So run the
profile site export for the freeze first.

The CLI does the same with local files: `--cms-fields` and `--cms-manifest`,
the site run's `manifest.json`. At the freeze both are required.

If none of the values is for a profile in the export, the run refuses even
with `acceptUnmatchedCms`: the values are of another database or stage. Run
the profile site export for this freeze on the same stage, then this one.

### Delegations and consolidations after the TDH block

The delegations loop runs every minute, during the freeze too. So:

- the file holds only the delegations with a block at or before the TDH
  block (`rules.delegations` is `through_tdh_block`). Later ones are left
  out and only counted (`stats.delegations_after_tdh_block`);
- consolidations after the TDH block are different: the loop has already
  applied them to the identities with a partial TDH write. So are
  primary-address delegations, which change an identity's primary address.
  The run refuses these unless `acceptConsolidationsAfterFreeze` is at least
  their number. The file records the exact counts
  (`stats.consolidations_after_tdh_block`,
  `stats.primary_address_delegations_after_tdh_block`). A revoked
  consolidation is counted too: it leaves a row at the revocation's block;
- a delegation revoked after the TDH block is not counted. The loop deletes
  its row, so it is missing from the file, and nothing in the database shows
  it was there. A partial TDH write after the day's full write can't be told
  apart from the full write once the identities sync has announced it, so
  that can't be counted either; the consolidation rows above are what such a
  write follows.

### When the job refuses

The job refuses, and writes nothing, when:

- `IDENTITY_FREEZE_AT` is unset, is not a time, or is not `freezeAt`. It
  reads the setting as the profile site does (`Z` or `+00:00`, with or
  without milliseconds, or Unix milliseconds), from the `prod/lambdas`
  secret in the function's region, at the start of each run. A warm
  container's environment keeps the secret as it was when the container
  started, so the run doesn't use it: a fix to the secret is seen on the
  next run. See the README's "The freeze setting, before Monday";
- `revision` is not the commit the function was built from;
- the profile site values can't be tied to the freeze (above);
- a run for the freeze already wrote its pointer and `replacePointer` isn't
  set;
- the snapshot was taken before the freeze, less than 2 minutes after it,
  or more than 90 minutes after it (unless `acceptSnapshotGapMinutes`
  covers the gap);
- the replica is as far behind its writer as the snapshot is after the
  freeze, or further. The lag comes from
  `information_schema.replica_host_status`. When it can't be read, the run
  refuses unless it has `acceptUnknownReplicaLag: true`;
- the database is not at the freeze day, or a count is not acknowledged.
  The error names every reason, with the CLI's exit code. The counts include
  profile rows saved after the freeze whether or not the save was logged,
  and the consolidations above;
- less than a minute of the function's time is left. The error names the
  step reached: each read, the delegations read, and the start of the
  uploads.

## What a run writes

A run writes these objects under
`identity-export/<prod|staging>/<time>-<request>[-rehearsal]/`:

- `identity-export.json`: the file the import's builder reads;
- `summary.json`: the header, rules, stats and notes;
- `links.json`;
- the manifest, written last.

The manifest is `manifest.json` only for a run at the freeze. A rehearsal
(`noFreeze`) writes `manifest.unusable.json`, so it can't be taken for the
import. The manifest records:

- the scope (inputs and options), the stage, the revision and the build's
  commit;
- `IDENTITY_FREEZE_AT` as read, and the secret it was read from;
- the profile site run the values came from;
- the snapshot's time, its gap from the freeze (`snapshot_gap_ms`, and
  rounded, `snapshot_gap_seconds`), the replica's lag, and whether an
  unknown lag was accepted;
- whether the run replaced a pointer, and the pointer it replaced;
- the size and sha256 of every object, `links.json` included.

After a `manifest.json`, the job writes the pointer
`identity-export/<stage>/by-freeze/<freezeAt>.json`. It names the run's
prefix, its manifest and the manifest's sha256, and the export's key and
sha256. It is written only if no pointer exists, unless the run has
`replacePointer: true`. If S3 refuses the write because a pointer is there,
the job reads it back: a pointer naming this run's prefix and manifest
sha256 is its own write, whose answer was lost, and counts as written. A run
whose pointer can't be written is still whole: the response has
`pointerKey: null` and `pointerError`.

Everything in the bucket, the pointer included, expires 30 days after it
was written. The coordinator keeps a copy of the real export: `out.json`,
every file in `links.json` (the manifest included), and the pointer, from
`presignedPointerUrl`. The README's download commands work here too, with
`identity-export` as the folder.

## When to call it

The function runs one invocation at a time, and the daily dump starts at
01:00 UTC and runs up to 15 minutes. A call made while another run or the
dump is going is refused at once with `TooManyRequestsException`. No run
started: wait for the other run to end and call again. This is not a CLI
failure (below), so don't wait 15 minutes or look for a run.

On Tuesday the profile site export runs first, then this export, one after
the other. Plan for the dump:

- start this export so it ends before 01:00: no later than 01:00 minus
  Monday's `seconds` and a few minutes' margin. A run still going at 01:00
  delays the dump until it ends;
- between 01:00 and about 01:15 a call is refused while the dump runs. To
  see whether it has ended, look for its `FINISHED IN` line in the
  function's logs, or just call: a throttled call costs nothing;
- after the dump, start before 01:30, or add `"acceptSnapshotGapMinutes"`
  for a later start.

## Staging rehearsal (eu-west-1)

PowerShell 5.1:

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"identityExport","noFreeze":true,"noExtraIds":true,"noCmsFields":true}'
aws lambda invoke --region eu-west-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

## Monday: the production timing run, no freeze (us-east-1)

This run reads the whole production replica to time Tuesday's export. It
writes only `manifest.unusable.json`. Put the waves list at
`identity-export/inputs/waves.json` first, or use `noExtraIds`.

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"identityExport","noFreeze":true,"extraIds":{"key":"identity-export/inputs/waves.json"},"cmsFields":{"key":"profile-site-export/prod/<profile site run>/cms-fields.json"}}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

If the CLI prints an error of its own and no `StatusCode`, the run may
still have finished, and its `seconds` is only in the logs. Don't run it
again: see "If the CLI fails", below. A `TooManyRequestsException` is not
that: see "When to call it".

Read `seconds` in `out.json` and send it to the identity lead. If it is above
about 600, Tuesday's run may not fit one invocation. Check in `out.json`:

- `stage` is `prod`.
- `identityFreezeAtReading` is `time` and `identityFreezeAt` is
  `2026-11-24T00:00:00.000Z`. Anything else, and Tuesday's run will be
  refused: ask 6529.io to fix the `prod/lambdas` secret, then run this again.
  Each run reads the secret afresh.
- `buildCommit` is the commit deployed. If it is `null`, the deployed build
  doesn't record its commit, and Tuesday's event needs
  `"revision":"<40-hex commit deployed to production>"`.
- `evidence.replicaLagMs` is a number. If it is `null`, Tuesday's run will
  refuse unless it is given `"acceptUnknownReplicaLag":true`. Tell the
  identity lead, and settle it before Tuesday.

## Tuesday: the run at the freeze (us-east-1)

Run it after:

- 6529.io's `IDENTITY_FREEZE_AT` is set to the freeze in the
  `prod/lambdas` secret;
- the freeze day's TDH run and its identities sync have finished;
- the profile site export for the freeze has finished and written its
  pointer;
- at least 2 minutes after the freeze;

and at a time "When to call it" allows.

Start with no acknowledgements. A refused run lists every count. Then add
each one and run again:

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"identityExport","freezeAt":"2026-11-24T00:00:00Z","expectTdhBlock":<B_T>,"extraIds":{"key":"identity-export/inputs/waves.json"}}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

After a refusal, add only the fields its error named, as it names them. For
example:
`"acceptOverCredit":<N>,"acceptEditsAfterFreeze":<N>,"acceptRatingsChangedAfterFreeze":<N>,"acceptProfileWritesAfterFreeze":<N>,"acceptConsolidationsAfterFreeze":<N>,"acceptMissingExtraIds":<N>,"acceptUnmatchedCms":<N>`.
Every count is exact, except `acceptConsolidationsAfterFreeze`, which is a
ceiling. If the run is refused because the replica is behind, wait a few
minutes and run it again.

If the CLI fails without a `FunctionError`, don't run it again: see "If the
CLI fails".

A second run for the same freeze is refused before it reads, because the
first run's pointer exists. Only if the coordinator picks a new run as the
export, add `"replacePointer":true`. Its manifest records the pointer it
replaced.

## What to check in the response (`out.json`)

- `stage` is the one you meant, and `prefix` starts with
  `identity-export/<stage>/`, with no `-rehearsal` for the real run.
- `manifestKey` ends in `manifest.json`, and `usable` is true.
- `manifestSha256`: send it with the prefix, so whoever fetches the
  manifest can check it.
- `pointerKey` is `identity-export/<stage>/by-freeze/<freezeAt>.json`. If it
  is `null`, the run is whole, but nothing points to it. Read
  `pointerError`:
  - it says the pointer names another run, written while this one ran:
    that other run stays the export. Send both runs' `prefix` and
    `manifestSha256` to the coordinator. Only if the coordinator picks this
    run, run again with `"replacePointer":true`.
  - it says reading the pointer back failed: it is unknown which run the
    pointer names. Ask for links by `freezeAt`: `links-out.json` names that
    run's prefix and manifest sha256. If they are this run's, it is the
    export. Otherwise do as in the case above.
  - Any other `pointerError`: send the coordinator this run's `prefix` and
    `manifestSha256`, and fetch fresh links by `prefix`, not `freezeAt`.
- `revision` is the commit deployed, and `buildCommit` is the same commit
  (or `null`, with the revision you gave).
- `cmsFieldsSource` names the profile site run at the freeze and its
  manifest's sha256.
- `host`, `readOnly: true` and `evidence`:
  - `transactionReadOnly` is true;
  - `serverReadOnly` or `innodbReadOnly` is true;
  - `replicaLagMs` is below `snapshotGapMs`, or `null` only in a
    run given `acceptUnknownReplicaLag`.
- `bucketPrivacy.owner` is the function's own account.
- `identityFreezeAtSecret` is `prod/lambdas`, `identityFreezeAtReading` is
  `time`, and `identityFreezeAt` equals `frozenAt`.
- `snapshotAt` and `snapshotGapMs`: at least 120000. The run compares the
  gap in milliseconds; `snapshotGapSeconds` is the same gap, rounded.
- `acceptUnknownReplicaLag` and `replacePointer`: true only if you gave
  them.
- `identities`, `ratings` and `tdhBlock`.
- `seconds`.
- `presignedManifestUrl`, `presignedLinksUrl`, `presignedPointerUrl` and
  `linksLastAtMost`. The links end sooner if the signing session ends
  first.

`identityExportLinks` gives fresh links, for the freeze's run by its
pointer:

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii links-event.json '{"job":"identityExportLinks","freezeAt":"2026-11-24T00:00:00Z"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 120 --cli-binary-format raw-in-base64-out --payload file://links-event.json links-out.json
```

or for any run by its prefix: `{"job":"identityExportLinks","prefix":"<prefix
from out.json>"}`. Give one or the other. By freeze, it refuses if the
manifest's sha256 is no longer the one the pointer names. `links-out.json`
carries `manifestSha256` too, and, by freeze, `presignedPointerUrl`.

## If the CLI fails

A failed run returns a function error and leaves no manifest: the CLI
prints `"FunctionError": "Unhandled"` with its `StatusCode`, and `out.json`
holds the `errorMessage`. Fix what it names and run again; every run has its
own prefix.

A `TooManyRequestsException` means the call was refused before any run
started: see "When to call it". Call again; none of the steps below apply.

Any other CLI failure is not a run failure. The CLI waits up to 960 s for
the answer, but a NAT can drop a connection idle for 350 s. The CLI then
prints an error of its own (a read timeout, or a closed connection) and no
`StatusCode`, and leaves no `out.json`, while the run goes on and may
finish.

If the CLI failed that way and printed no `FunctionError`:

1. Don't run it again.
2. Wait 15 minutes from the start: by then the run has ended.
3. For a run at the freeze, ask for its links by `freezeAt` (above). If the
   run finished, `links-out.json` names its prefix and manifest. If it says
   there is no run for that freeze, read the logs, as below.
4. For a rehearsal (it has no pointer), read `[EXPORT DONE]` in the
   function's logs, as the README shows. The identity export's line starts
   with `[EXPORT DONE] [identity-export/`; the profile site export's lines
   share the log. It gives the prefix, the manifest's name and the seconds.
   Then ask for links by that `prefix`.

No identity export `[EXPORT DONE]` line within the hour means the run didn't
finish: run it again.
