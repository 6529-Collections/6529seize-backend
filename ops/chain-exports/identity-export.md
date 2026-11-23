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
- `acceptNoCmsFields: true` (`--accept-no-cms-fields`): at the freeze, the
  profile site export's `cms-fields.json` is empty because it has no sites
  (below).
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
- `acceptUnknownReplicaLag`: at the freeze, the untrusted lag cases the run
  may go through, as the refusals name them: `"unreadable"`,
  `{"dated_ahead":<smallest lead in ms>}` (the smaller of Monday's two
  `replicaLagAheadMs` readings minus 60000), or
  `{"older_than_gap":<largest row age in ms>}` (the larger of Monday's two
  `replicaLagAgeMs` readings plus 60000), one or a list; work the bound out
  as in the README's
  [Working out a bound from Monday](README.md#working-out-a-bound-from-monday).
  `true`, a bare `"dated_ahead"` or `"older_than_gap"`, other names and
  repeats are refused. Only as in the README's "An unknown replica lag":
  after running once more, for a case Monday's rehearsal also showed, and
  with the identity lead's agreement. What the run holds a reading to,
  accepted or not, is the README's [What the run
  enforces](README.md#an-unknown-replica-lag) list: `unreadable` only for a
  reader that isn't Aurora (`ER_UNKNOWN_TABLE 1109`,
  `ER_UNKNOWN_SYSTEM_VARIABLE 1193`), no row for this server, a null lag or
  a null timestamp; a bound's 60000 ms margin counted as lag; with a
  `dated_ahead` bound, a fresh reading or one older than the gap refused;
  the lag the row reports always held to the gap. The response and the
  manifest record the list as given, bounds included, and the case accepted
  (`replicaLagAccepted`, `replica_lag_accepted`). The CLI has no such flag:
  it reads no replica lag.
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

A site export with no sites writes `{}`. The run refuses that file, before
reading the database, unless it has `acceptNoCmsFields: true`
(`--accept-no-cms-fields`): a fault in the site export that wrote `{}`
would otherwise send every identity to the chain without its cms value.
Give it only if that site export really has no sites. With it, no identity
gets a value, and the file's notes and `acknowledged.no_cms_fields` say so.
The flag with a file that has values is refused too.

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
- the replica may be as far behind its writer as the snapshot is after the
  freeze, or further, in milliseconds: its lag plus the age of the row it
  was read from (`evidence.replicaLagMs`, `evidence.replicaLagAgeMs`), plus
  1.5 s for the row's timestamp, as the README's rules for every export
  say. Such a lag is never accepted;
- the lag can't be trusted, unless `acceptUnknownReplicaLag` names that
  case: it can't be read (`unreadable`), its row is dated ahead of UTC
  (`dated_ahead`, how far ahead in `evidence.replicaLagAheadMs`), or its row
  is older than the whole time since the freeze (`older_than_gap`).
  `evidence.replicaLagUnknown` names the first two, and
  `evidence.replicaLagError` gives the reason: the server's error code and
  number only (its message, which can name the user and host, goes to the
  function's log), or the export's own. A row whose age can't be trusted but
  which reports a lag of the gap less 1.5 s or more is refused, even with
  its case accepted; a stale row's lag never changes, so run once more, and
  if that refusal comes back unchanged, report it. What to do is in the
  README's "An unknown replica lag", and what the run enforces in its [What
  the run enforces](README.md#an-unknown-replica-lag) list; the refusal says
  the same;
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
was written. Within the links' 6 hours, the coordinator downloads a complete
copy of the real export and keeps it with `out.json`: every file in the
links file, the manifest included, and the pointer. These commands download
everything and check every file's sha256 against the manifest. They are the
README's, for this job: each run's files go into their own
`identity-export-<run>/`, the pointer included, so a rehearsal's files never
mix with Tuesday's. Start in an empty folder, beside `out.json`. They work
for `links-out.json` from the links job too: put its name in place of
`out.json`.

PowerShell:

```text
$ErrorActionPreference = 'Stop'
& {
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $ProgressPreference = 'SilentlyContinue'
  $out = Get-Content out.json -Raw | ConvertFrom-Json
  $run = Split-Path (Split-Path $out.manifestKey -Parent) -Leaf
  $dir = "identity-export-$run"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Invoke-WebRequest -UseBasicParsing $out.presignedLinksUrl -OutFile links-now.json
  $links = (Get-Content links-now.json -Raw | ConvertFrom-Json).links
  foreach ($p in $links.PSObject.Properties) { Invoke-WebRequest -UseBasicParsing $p.Value -OutFile (Join-Path $dir $p.Name) }
  if ($null -eq $links.PSObject.Properties['links.json']) { Copy-Item -Force links-now.json "$dir\links.json" }
  if ($out.presignedPointerUrl) { Invoke-WebRequest -UseBasicParsing $out.presignedPointerUrl -OutFile "$dir\pointer.json" }
  $manifestFile = Join-Path $dir (Split-Path $out.manifestKey -Leaf)
  $manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
  $wrong = @($manifest.files | Where-Object { $f = Join-Path $dir $_.name; -not (Test-Path -LiteralPath $f) -or (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower() -ne $_.sha256 })
  "$($manifest.files.Count) files, $($wrong.Count) wrong"
  (Get-FileHash $manifestFile -Algorithm SHA256).Hash.ToLower() -eq $out.manifestSha256
}
```

It must print `<n> files, 0 wrong` and then `True`. A download that fails
stops it with an error and no count; a file the links don't name counts as
wrong. Either way, fetch it again within the links' 6 hours, or ask for
fresh links first.

bash, with `curl` and `jq` (`shasum -a 256 -c` instead of `sha256sum -c` on
macOS). `j` drops the carriage returns jq writes on Windows:

```text
j() { jq -r "$@" | tr -d '\r'; }
run=$(basename "$(dirname "$(j .manifestKey out.json)")"); dir="identity-export-$run"; mkdir -p "$dir"
curl -fsS -o links-now.json "$(j .presignedLinksUrl out.json)"
j '.links | to_entries[] | "\(.key)\t\(.value)"' links-now.json | while IFS=$'\t' read -r name url; do curl -fsS -o "$dir/$name" "$url" || echo "FAILED $name"; done
[ "$(j '.links | has("links.json")' links-now.json)" = true ] || cp -f links-now.json "$dir/links.json"
pointer=$(j '.presignedPointerUrl // empty' out.json); [ -n "$pointer" ] && curl -fsS -o "$dir/pointer.json" "$pointer"
manifest="$dir/$(basename "$(j .manifestKey out.json)")"
j '.files[] | "\(.sha256)  \(.name)"' "$manifest" | (cd "$dir" && sha256sum -c --quiet) && echo "every file matches"
echo "$(j .manifestSha256 out.json)  $manifest" | sha256sum -c
```

It must print `every file matches` and then `OK`.

Anyone with read access to the bucket can also use
`aws s3 cp --recursive s3://<bucket>/<prefix> ./identity-export-<run>/`.

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
- `replicaLagCase` is `null`: the lag and its row's age could be trusted.
  Otherwise it names the case a real run would refuse on: `unreadable`,
  `dated_ahead` or `older_than_gap`. A rehearsal has no freeze, so it
  holds the row's age to the 2-minute minimum gap alone, the shortest gap
  Tuesday's run can have. Write that name down; it is the only one Tuesday
  may accept.
- `evidence.replicaLagMs` and `evidence.replicaLagAgeMs` are numbers, the
  age well under a minute on a healthy reader. An age of hours, or the case
  `dated_ahead` (with its lead in `evidence.replicaLagAheadMs`), means
  `LAST_UPDATE_TIMESTAMP` isn't in UTC. With the case `unreadable`,
  `evidence.replicaLagError` says why.
- Read the lag twice: a few minutes after this run, take a quick second
  reading with a one-profile profile site rehearsal
  (`"rehearsal":true,"profile":"<a profile id>"`, which reads the same
  reader endpoint in seconds), or run this rehearsal again. Compare the two
  readings' `evidence.replicaLagAgeMs` (or, for `dated_ahead`,
  `evidence.replicaLagAheadMs`), not their case names. If the age grew, or
  the lead shrank, by about the wait, the reader stopped updating its row:
  report it, and never accept it on Tuesday. If it stayed the same (a time
  zone offset), write it down: Tuesday's `older_than_gap` bound is the
  larger age plus 60000, its `dated_ahead` bound the smaller lead minus
  60000, worked out as in the README's [Working out a bound from
  Monday](README.md#working-out-a-bound-from-monday). Never round a bound or
  pick a smaller one: a loose bound hides a stall.
- With the case `unreadable`, `evidence.replicaLagError` must be one the
  run accepts: `ER_UNKNOWN_TABLE 1109`, `ER_UNKNOWN_SYSTEM_VARIABLE 1193`,
  no row for this server, a null lag or a null timestamp. Any other reason,
  such as a timeout, can't be accepted on Tuesday: report it.
- If either reading names a case, tell the identity lead and settle it
  before Tuesday: Tuesday can accept only a case Monday showed, by its
  name, as in the README's "An unknown replica lag".

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
ceiling.

If the run is refused because of the replica:

- it says the replica may be behind its writer: wait a few minutes and run
  it again. This refusal is never accepted;
- it says the lag can't be read, or its row is dated ahead of UTC or older
  than the time since the freeze: follow the README's "An unknown replica
  lag". Run once more; then accept only the case the refusal names, and only
  if Monday's rehearsal showed it, with the identity lead's agreement:
  `"acceptUnknownReplicaLag":"unreadable"`; for `older_than_gap` the bound
  from Monday's age, `"acceptUnknownReplicaLag":{"older_than_gap":<ms>}`
  with Monday's larger `replicaLagAgeMs` plus 60000; for `dated_ahead` the
  bound from Monday's lead, `"acceptUnknownReplicaLag":{"dated_ahead":<ms>}`
  with Monday's smaller `replicaLagAheadMs` minus 60000, as in the README's
  [Working out a bound from
  Monday](README.md#working-out-a-bound-from-monday). A row older than its
  bound, or one whose lead has shrunk below it, means the reader stopped:
  report it, and don't move the bound. Otherwise report it. Don't keep
  running it until 01:30;
- it says `unreadable` was accepted, but the reading's reason isn't one it
  covers (a timeout, a refusal, a parse error): a reader falling behind
  can time out. Run once more; if it returns, report it;
- it says an untrusted row reports a lag of the gap less 1.5 s or more
  (with a bound accepted, less another 60000 ms for a stall within the
  bound's margin): its lag never changes, so run once more, and if the
  refusal comes back unchanged, report it;
- it says `dated_ahead` was accepted but the reader's row reads as fresh,
  or older than the gap: a reader dated ahead that stopped updating reads
  that way once its lead has run out. Run once more without changing the
  event; if it reads the same, report it.

If the run is refused because the profile site export's `cms-fields.json`
is empty: add `"acceptNoCmsFields":true` only if that export really has no
sites; otherwise report it to the coordinator.

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
  - it says reading the pointer back failed: ask for links by `freezeAt`.
    If their prefix is this run's, the pointer is this run's and all is
    well. If not, it names another run: do as in the case above, and fetch
    this run by its `prefix`.
  - Any other `pointerError` ("The pointer write failed", with the error's
    code or name only): send the coordinator this run's `prefix` and
    `manifestSha256`, and fetch fresh links by `prefix`, not `freezeAt`.
- `revision` is the commit deployed, and `buildCommit` is the same commit
  (or `null`, with the revision you gave).
- `cmsFieldsSource` names the profile site run at the freeze and its
  manifest's sha256.
- `endpoint` is `reader`, with `readOnly: true` and `evidence`: the export
  read DB_HOST_READ. The reader's hostname is in neither the response, the
  manifest (whose `read.endpoint` is the same label) nor the pointer; it is
  only in the function's log, as `[READ REPLICA ...]`.
  - `transactionReadOnly` is true;
  - `serverReadOnly` or `innodbReadOnly` is true;
  - `replicaLagMs` plus `replicaLagAgeMs`, plus 1 500 ms, is below
    `snapshotGapMs`, and `replicaLagCase` and `replicaLagAccepted` are
    `null`. Otherwise both name the case accepted, which must be in
    `acceptUnknownReplicaLag` and be the case Monday showed; any lag the
    row reported, plus 1 500 ms (and 60 000 ms for a bound accepted), is
    still below `snapshotGapMs`.
- `bucketPrivacy.owner` is the function's own account.
- `identityFreezeAtSecret` is `prod/lambdas`, `identityFreezeAtReading` is
  `time`, and `identityFreezeAt` equals `frozenAt`.
- `snapshotAt` and `snapshotGapMs`: at least 120000. The run compares the
  gap in milliseconds; `snapshotGapSeconds` is the same gap, rounded.
- `acceptUnknownReplicaLag` is empty, and `replacePointer` false, unless
  you gave them.
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

When the read replica itself fails (a connection, a login, a `SELECT`),
`errorMessage` says "The read replica failed" and gives only the error's
code and number, such as `ER_ACCESS_DENIED_ERROR 1045`: the server's
message can name the user and host. Any other network call that fails (an
S3 upload, the secret's read, a TLS handshake) says "A network call
failed", again with the code only. A DNS failure (`EAI_AGAIN`,
`ENOTFOUND`) on either says "DNS lookup failed, retry" with its code, and
never the host: run it again. An AWS service's refusal (S3, Secrets
Manager) says "An AWS call was refused" with its name and HTTP status,
such as `AccessDenied (403)`. A call that got no answer at all (a timeout,
a certificate it couldn't check) says "A network call failed" with its code
or name, not "refused". The full messages are in the function's log,
as `[READ REPLICA FAILED]`, `[NETWORK CALL FAILED]` and
`[AWS CALL REFUSED]`; a pointer's, as `[POINTER NOT WRITTEN]` and
`[POINTER READ-BACK FAILED]`.

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
3. For a run at the freeze, ask for its links by `freezeAt` (above). If
   `links-out.json`'s prefix starts with this run's start time
   (`identity-export/prod/<UTC start time>-...`), this run finished and its
   pointer was written. If it names an earlier run (as after a
   `replacePointer` run whose answer was lost), or says there is no run for
   that freeze, this run may still have finished with a manifest but no
   pointer: read the logs, as below.
4. For a rehearsal (it has no pointer), read the logs.

The logs are read as the README shows. The identity export's line starts
with `[EXPORT DONE] [identity-export/`; the profile site export's lines
share the log. It gives the run's prefix, its manifest's name and sha256
(`[MANIFEST SHA256 ...]`), its pointer (`[POINTER ...]`: the key,
`NOT WRITTEN`, or `NONE (A REHEARSAL)`) and its seconds. Then ask for links
by that `prefix`.

No identity export `[EXPORT DONE]` line within the hour means the run didn't
finish: run it again.
