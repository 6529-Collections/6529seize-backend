# Chain exports

The two exports the 6529 chain's import reads run inside 6529.io's account as
jobs of the `dbDumpsDaily` function, invoked by hand. The daily dump still
runs for its schedule's event (or an empty event); any other event must name
a job the function knows, or it fails. Each export:

- reads only the read replica: `DB_HOST` and `DB_HOST_READ` must both be set
  and differ, and the server must itself be read-only (`read_only` or
  `innodb_read_only` on), so a reader endpoint that routes to the writer is
  refused;
- reads in one `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY` with
  the session in UTC, and records the server's clock at the snapshot
  (`snapshot_at`);
- holds the snapshot to the freeze, which each job's event names in its own
  field: `frozenAt` in the profile site export, `freezeAt` in the identity
  export. It refuses a snapshot taken before the freeze or more than 90
  minutes after it, unless `acceptSnapshotGapMinutes` allows more. A real
  run also refuses:
  - when `IDENTITY_FREEZE_AT` is unset, is not a time, or differs from the
    freeze. It reads the setting as the site does (`Z` or `+00:00`, with or
    without milliseconds, or Unix milliseconds), from the `prod/lambdas`
    secret in the function's region, at the start of each run. A warm
    container's environment keeps the secret as it was when the container
    started, so the run doesn't use it: a fix to the secret is seen on the
    next run;
  - a snapshot less than 2 minutes after the freeze, so the replica has the
    writes made before it;
  - a replica as far behind its writer as the gap less 1.5 s, or further.
    The lag comes from this reader's newest row in
    `information_schema.replica_host_status` (`evidence.replicaLagMs`). A
    lagging reader's row can be stale, so the row's age counts too
    (`evidence.replicaLagAgeMs`): lag plus age, plus 1.5 s because the age
    can read that much low (a row up to 1 s ahead reads as 0, and a
    timestamp in whole seconds can round by 0.5 s), must be below the gap.
    The age reads `LAST_UPDATE_TIMESTAMP` as UTC. That relies on Aurora's
    time zone being UTC, its default unless the cluster's `time_zone`
    parameter sets another; the snapshot's session is in UTC too;
  - a lag it can't trust, unless that case is accepted by name as in "An
    unknown replica lag", below: a lag that can't be read
    (`evidence.replicaLagUnknown` is `unreadable`), a row dated ahead of
    UTC (`dated_ahead`, how far ahead in `evidence.replicaLagAheadMs`), or
    a row older than the whole gap (`older_than_gap`).
    `evidence.replicaLagError` gives the reason: the
    server's error code and number only (its message, which can name the
    user and host, goes to the function's log), or the export's own;
- writes only to the private bucket `6529-chain-exports-<account>-<region>`
  under its own prefix. Every call names the function's own account as the
  bucket's expected owner, and every upload carries a SHA-256 checksum S3
  verifies. Before every run it checks that the bucket blocks all public
  access and that S3 calls its policy private;
- writes its manifest last, with the size and sha256 of every object
  (`links.json` included), so a run that stops early has none;
- returns presigned download links, valid for at most 6 hours.

Each job's own section adds its own rules.

### An unknown replica lag

Three refusals mean the run can't trust the reader's lag. Each names its
case:

- `unreadable`: the lag can't be read (an error, no row, no lag, no
  timestamp);
- `dated_ahead`: the lag row is dated ahead of UTC, so
  `LAST_UPDATE_TIMESTAMP` may not be in UTC;
- `older_than_gap`: the lag row is older than the whole time since the
  freeze. `LAST_UPDATE_TIMESTAMP` may not be in UTC, or the reader stopped
  updating its row.

For each:

1. Run it once more first. A passing error, such as a timeout, clears, and
   through the reader endpoint the run may land on another reader. If the
   `older_than_gap` refusal returns with the row's age grown by the time
   you waited, or the `dated_ahead` refusal with its lead shrunk, the
   reader stopped updating: report it.
2. Accept it only for a reading Monday's rehearsal also showed, and only
   with the identity lead's agreement, by naming its case:
   - `"acceptUnknownReplicaLag":"unreadable"`;
   - `"acceptUnknownReplicaLag":{"older_than_gap":<ms>}`, with the largest
     row age to accept: Monday's larger `replicaLagAgeMs` plus 60000;
   - `"acceptUnknownReplicaLag":{"dated_ahead":<ms>}`, with the smallest
     lead over UTC to accept: Monday's smaller `replicaLagAheadMs` minus
     60000;
   - or a list of these, such as `["unreadable",{"dated_ahead":7140000}]`.

   Take the margin as exactly 60000 ms: the run counts that much possible
   stall as lag, on top of the lag the row reports. A time zone offset
   keeps a row's age, or its lead, constant, so it passes; a reader that
   stopped updating makes the age grow, or the lead shrink, past the bound,
   so it is refused, as a bare `"older_than_gap"` or `"dated_ahead"` is.
   With a `dated_ahead` bound given, any other reading is refused too: a
   reader dated ahead that stops updating reads as fresh once its lead has
   run out. An age bound is 120000 to 51000000 ms, a lead bound 1740000 to
   51000000 ms: time zones reach 14 hours from UTC, and none is less than
   30 minutes from it. A rerun that lands on a reader showing another case
   is refused, as `true` is.
   For an error, accept only `ER_UNKNOWN_TABLE 1109` or
   `ER_UNKNOWN_SYSTEM_VARIABLE 1193` (the reader isn't Aurora). The run
   records the case it accepted (`replicaLagAccepted`, and
   `replica_lag_accepted` in the manifest, beside the acceptance as given,
   bounds included).

3. Otherwise report it: any other error, such as `ER_PARSE_ERROR 1064`, is
   a fault, and a row past the bound accepted means the reader stopped:
   don't move the bound.

An accepted case still holds the lag the row reports to the gap: a row
whose age can't be trusted but which says the reader is behind by the gap
less 1.5 s or more is refused. As a stale row's lag never changes, run once
more, and if that refusal comes back unchanged, report it. Only when the
row reports no lag at all does the 2-minute minimum gap alone decide. A
trusted lag that is simply too large is never accepted: wait a few minutes
and run again. The refusals say the same.

No database password and no long-lived key is handled by a person.

## One-time setup, before Monday's rehearsal (administrative)

The deployment roles can't create buckets
(`ops/iam/backend-*/README.md`: storage provisioning is administrative), so
the bucket is made once per region with administrative credentials. Both
stacks must exist, and be confirmed, before Monday's rehearsal:

```text
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region eu-west-1
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region us-east-1
```

Staging runs in `eu-west-1`, production in `us-east-1`; both are in one
account, so the region is what tells them apart. The bucket's name is
predictable, and the account id is in this repository. A bucket of that
name made first in another account would be refused: every call names this
account as the expected owner.

The bucket policy allows the function role (`lambda-vpc-role`) to read the
bucket's public access block and policy status, and to put and get objects
under `profile-site-export/` and `identity-export/`. It denies CloudFront's
service principal and plain HTTP. Objects expire after 30 days.

In one account, a bucket policy's Allow adds to what an identity's own
policies grant; it does not narrow them. Identities in the account whose
own policies allow S3 on every bucket can reach this one too, as with any
bucket in the account.

The function may not list the bucket, so S3 answers a read of a key that
doesn't exist with 403 rather than 404. The export reports such a read as
"no manifest".

## The freeze setting, before Monday

`IDENTITY_FREEZE_AT` must be a key of the `prod/lambdas` secret in the
stage's region: `us-east-1` for prod, `eu-west-1` for staging. Its value is
the freeze, `2026-11-24T00:00:00Z`.

Ask 6529.io to set it before Monday's rehearsal. A future time has no effect
on the site until it arrives.

The export reads the secret afresh on every run. 6529.io's API doesn't: it
reads `prod/lambdas` only when its own environment has
`API_LOAD_SECRETS=true`, and a running instance keeps the values it started
with. So 6529.io also:

1. confirms that the API's startup log shows `[LOAD SECRETS ENABLED true]`.
   If it doesn't, they also set `IDENTITY_FREEZE_AT` in the API's own
   environment, to the same value;
2. redeploys or restarts the API after setting it, so that every instance
   has it;
3. just after 00:00 UTC on Tuesday, before the export runs, has someone try
   to publish a profile site (in the editor, or
   `POST /api/profile-cms/packages/{id}/publish`). It must fail with 423
   and the code `IDENTITY_FROZEN`. If the publish goes through, the site
   isn't frozen: stop, and tell the coordinator before running the export.

Monday's rehearsal passes only when it reads the setting as `time`, equal
to Tuesday's freeze.

## Why the file is private

- The bucket blocks public ACLs and public policies, and ignores and
  restricts both (`PublicAccessBlockConfiguration`, all four true). S3
  refuses any public grant on it.
- Its policy names no public principal and denies CloudFront's service
  principal, which origin access control uses. A legacy origin access
  identity would need an Allow in this policy, and there is none.
- No CloudFront distribution or other definition in this repository names
  the bucket. The only distributions here are the IPFS edge
  (`ops/ipfs/cloudformation/edge.yaml`, its own origins) and the NextGen
  distribution the deployment role may update.
- Every run calls `GetPublicAccessBlock` and `GetBucketPolicyStatus` as the
  bucket's owner, and refuses to write unless all four blocks are on and
  `IsPublic` is false. Each run's response carries `bucketPrivacy`.

The team confirms once, before Monday:

- the stack was created from this template, in both regions;
- no other policy grants anyone outside the account access to the bucket;
- the account's S3 Block Public Access is on.

## Who invokes, and how

- **Who:** the deployment roles may invoke only `dbMigrationsLoop`, and can't
  read the bucket. The invoker needs `lambda:InvokeFunction` on
  `dbDumpsDaily` in the region of the stage it runs. The deploy lead reports
  that its credentials can invoke functions in both stages. Confirm that
  before Monday, or have an admin grant it.
- **Fetching:** needs no AWS access; the response's presigned links are
  enough.
- **CLI:** AWS CLI v2 is required, since `--cli-binary-format` is v2 only.
  Always pass `--region`.
- **Event:** write it to a file and pass it as `file://event.json`. Inline
  JSON loses its quotes in PowerShell 5.1.
- **No CLI retries:** set `AWS_MAX_ATTEMPTS` to 1. Otherwise the CLI calls
  again after a timeout or a throttle, which can start a second run after
  the first.
- **Stage:** the function's `NODE_ENV` names it. `production` is `prod` (in
  `us-east-1`) and `development` is `staging` (in `eu-west-1`). The response's
  `stage` and its prefix say which one ran.

PowerShell 5.1:

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

bash:

```text
printf '%s' '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z"}' > event.json
AWS_MAX_ATTEMPTS=1 aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

The examples below are PowerShell. In bash, write the event with `printf`
and put `AWS_MAX_ATTEMPTS=1` before `aws`, as above.

## Profile site export

Event fields:

- `frozenAt` (required): the freeze, as ISO UTC or 13-digit Unix
  milliseconds. In a real run it must equal `IDENTITY_FREEZE_AT`.
- `rehearsal` (optional, `true`): a timed rehearsal that is never imported.
  Its prefix ends in `-rehearsal`, and its manifest is
  `manifest.unusable.json`. It doesn't require `IDENTITY_FREEZE_AT`, the
  2-minute gap or the lag check. It reports how it read
  `IDENTITY_FREEZE_AT` (`identityFreezeAtReading`: `unset`, `not_a_time` or
  `time`), and it records site writes after `frozenAt` instead of refusing
  them.
- `concurrency` (optional, 1 to 4; default 1): profiles exported at once, so
  their stored publication records are fetched in parallel. The output is
  the same at any setting. Tuesday uses the setting Monday proved.
- `profile` (optional): one profile id only. Its prefix ends in
  `-profile-<id>`, and its manifest is `manifest.partial.json`.
- `publicApi` (optional): an https base URL to check exported primaries
  against, as the CLI's `--public-api`.
- `acceptSnapshotGapMinutes` (optional): allow a snapshot taken up to this
  many minutes after `frozenAt`. Without it the limit is 90.
- `acceptWritesAfterFreeze` (optional): site writes after `frozenAt` the
  coordinator accepted, at most 100, each `source:id@time` exactly as the
  refusal lists it. Use it only as in "A publish that straddles the
  freeze", below.
- `acceptUnknownReplicaLag` (optional): the untrusted lag cases the run may
  go through, as the refusals name them: `"unreadable"`,
  `{"dated_ahead":<smallest lead in ms>}` or
  `{"older_than_gap":<largest row age in ms>}`, one or a list; `true` and
  a bare `"dated_ahead"` or `"older_than_gap"` are refused. Only as in "An
  unknown replica lag" (top of this file): after running once more, for a
  reading Monday's rehearsal also showed, and with the identity lead's
  agreement. The manifest records the list, bounds included
  (`accept_unknown_replica_lag`), and the case accepted
  (`replica_lag_accepted`).
- `replacePointer` (optional, `true`): let this run replace the by-freeze
  pointer an earlier run for the same freeze wrote. Without it, the pointer
  is written only if none is there. Only for a real run of every profile,
  and only when the coordinator says so; the manifest records it
  (`replace_pointer`).

Unknown fields are refused.

Besides the rules every export keeps (top of this file), a real run of the
profile site export refuses a snapshot holding a site publication, archive
or pointer change after `frozenAt`, unless the coordinator accepted each of
those writes (`acceptWritesAfterFreeze`; see "A publish that straddles the
freeze").

`usable` in the response is true only for `manifest.json`, the one manifest
the import takes. A rehearsal is never usable; whether its stored
publication records were all fetched is `unavailableProfiles` (0 when they
were).

### Monday: the production timing run

This run says whether Tuesday's export fits the function's 15 minutes, at
the concurrency Tuesday will use: 4, against production's gateways.

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii rehearsal.json '{"job":"profileSiteExport","frozenAt":"<UTC time a few minutes ago, e.g. 2026-11-23T15:55:00Z>","rehearsal":true,"concurrency":4}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://rehearsal.json out.json
```

If the CLI prints an error of its own and no `StatusCode`, the run may
still have finished, and its `seconds` is only in the logs. Don't run it
again: see "If the CLI fails", below.

Read `seconds` and `unavailableProfiles` in `out.json`, and send them to
the identity lead.

- If `unavailableProfiles` is above 0, some stored publication records
  couldn't be fetched at 4. Run the rehearsal again with `"concurrency":1`.
  If that run has none, Tuesday uses 1.
- If `seconds` is above about 600 at the concurrency Tuesday will use,
  Tuesday's run doesn't fit one invocation. Then the export runs from a
  checkout on a machine with database access, by a person the coordinator
  arranges. No lane logs into a database.

Check in `out.json`:

- `stage` is `prod` in `us-east-1` (`staging` in `eu-west-1`). If it isn't,
  the function's `NODE_ENV` is wrong. Tell the deploy lead before Tuesday.
- `identityFreezeAtReading` is `time` and `identityFreezeAt` is
  `2026-11-24T00:00:00.000Z`. Anything else (`unset`, `not_a_time`, or
  another time), and the rehearsal hasn't passed: ask 6529.io to fix the
  secret (see "The freeze setting"), then run the rehearsal again. Each run
  reads the secret afresh.
- `replicaLagCase` is `null`: the lag and its row's age could be trusted.
  Otherwise it names the case a real run would refuse on: `unreadable`,
  `dated_ahead` or `older_than_gap`. The rehearsal works it out against the
  2-minute minimum gap alone, whatever its own `frozenAt`: a gap of
  moments would name `older_than_gap` on a healthy reader, and a gap of an
  hour would hide an offset Tuesday will see. Write the name down; it is
  the only one Tuesday may accept.
- `evidence.replicaLagMs` and `evidence.replicaLagAgeMs` are numbers, the
  age well under a minute on a healthy reader. An age of hours, or the case
  `dated_ahead` (with its lead in `evidence.replicaLagAheadMs`), means
  `LAST_UPDATE_TIMESTAMP` isn't in UTC. With the case `unreadable`,
  `evidence.replicaLagError` says why.
- Read the lag twice: a few minutes after the first rehearsal, run a
  one-profile rehearsal (`"rehearsal":true,"profile":"<a profile id>"`),
  which reads the same lag in seconds, and compare the two readings'
  `evidence.replicaLagAgeMs` (or, for `dated_ahead`,
  `evidence.replicaLagAheadMs`), not their case names. If the age grew, or
  the lead shrank, by about the wait, the reader stopped updating its row:
  report it, and never accept it on Tuesday. If it stayed the same (a time
  zone offset), write it down: Tuesday's `older_than_gap` bound is the
  larger age plus 60000, its `dated_ahead` bound the smaller lead minus 60000.
- If either reading names a case, tell the identity lead and settle it
  before Tuesday: Tuesday can accept only a case Monday showed, by its
  name, as in "An unknown replica lag" (top of this file).

Then test the download links: fetch the manifest and `links.json`, then one
file by its link, and check each against its sha256.

```text
$ErrorActionPreference = 'Stop'
& {
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $out = Get-Content out.json -Raw | ConvertFrom-Json
  Invoke-WebRequest -UseBasicParsing $out.presignedManifestUrl -OutFile manifest.json
  Invoke-WebRequest -UseBasicParsing $out.presignedLinksUrl -OutFile links.json
  $manifest = Get-Content manifest.json -Raw | ConvertFrom-Json
  $links = Get-Content links.json -Raw | ConvertFrom-Json
  $file = $manifest.files | Where-Object { $_.name -like 'files/*' } | Select-Object -First 1
  Invoke-WebRequest -UseBasicParsing $links.links.($file.name) -OutFile one-file
  (Get-FileHash manifest.json -Algorithm SHA256).Hash.ToLower() -eq $out.manifestSha256
  (Get-FileHash links.json -Algorithm SHA256).Hash.ToLower() -eq ($manifest.files | Where-Object { $_.name -eq 'links.json' }).sha256
  (Get-FileHash one-file -Algorithm SHA256).Hash.ToLower() -eq $file.sha256
}
```

bash, with `curl` and `jq` (`shasum -a 256 -c` instead of `sha256sum -c` on
macOS). `j` drops the carriage returns jq writes on Windows:

```text
j() { jq -r "$@" | tr -d '\r'; }
curl -fsS -o manifest.json "$(j .presignedManifestUrl out.json)"
curl -fsS -o links.json "$(j .presignedLinksUrl out.json)"
name=$(j '[.files[] | select(.name | startswith("files/"))][0].name' manifest.json)
curl -fsS -o one-file "$(j --arg n "$name" '.links[$n]' links.json)"
echo "$(j .manifestSha256 out.json)  manifest.json" | sha256sum -c
echo "$(j '.files[] | select(.name == "links.json") | .sha256' manifest.json)  links.json" | sha256sum -c
echo "$(j --arg n "$name" '.files[] | select(.name == $n) | .sha256' manifest.json)  one-file" | sha256sum -c
```

Each line must print `True` (PowerShell) or `OK` (bash). Send the result
with `seconds`.

The staging rehearsal is the same with `--region eu-west-1`.

### Tuesday: the real run, from 00:05 UTC

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z","concurrency":4}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

Use the concurrency Monday's passing rehearsal used: 4, or 1 if Monday fell
back to it. `IDENTITY_FREEZE_AT` must be set to the freeze in the
`prod/lambdas` secret; the run refuses otherwise.

If the CLI fails without a `FunctionError`, don't run it again: see "If the
CLI fails".

Start at least 2 minutes after the freeze; 00:05 UTC leaves room. A run
before 00:02 is refused. Start before 01:30 UTC, or add
`"acceptSnapshotGapMinutes":N`. If the run is refused because the replica
may be behind, wait a few minutes and run it again. If the refusal says
the lag can't be read, or its row is dated ahead of UTC or older than the
time since the freeze, follow "An unknown replica lag" (top of this file):
run once more, then accept only the case the refusal names, and only if
Monday's rehearsal showed it (for `older_than_gap` and `dated_ahead`, with
the bound from Monday's age or lead), or report it. Don't keep running it
until 01:30.

### A publish that straddles the freeze

A site published or changed just as the freeze began can leave a write
after `frozenAt`. The run then refuses, listing each write as
`source:id@time`:
`...writes after the freeze that no one has accepted: packages:<id>@2026-11-24T00:00:00.412Z...`.

1. Stop. Don't run it again with those writes yet.
2. Send the whole error to the coordinator.
3. Only after the coordinator accepts those writes, run again, listing each
   one exactly as the error does:

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii event.json '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z","concurrency":4,"acceptWritesAfterFreeze":["<source:id@time from the error>"]}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

Any other write is still refused, even one to the same package at another
time. The manifest and the response record the writes
(`writes_after_freeze`, `writesAfterFreeze`) and the accepted ones
(`accepted_writes_after_freeze`, `acceptedWritesAfterFreeze`).

### What to check in the response (`out.json`)

- `stage` is the one you meant, and `prefix` starts with
  `profile-site-export/<stage>/`. The real run's prefix has no `-rehearsal`
  or `-profile-` part.
- `manifestKey` ends in `manifest.json` and `usable` is true. Otherwise the
  run is not the export:
  - `manifest.unusable.json`: a rehearsal, or a stored publication record
    couldn't be fetched. Run again.
  - `manifest.partial.json`: one profile only.
- `manifestSha256`: the manifest's sha256. Send it with the prefix, so
  whoever fetches the manifest can check it.
- `pointerKey` is set: `profile-site-export/<stage>/by-freeze/<frozenAt>.json`
  names this run's prefix and the manifest's sha256. A later full run for
  the same freeze doesn't replace it. If `pointerKey` is null and
  `pointerError` is set, the run is still whole and usable, but nothing
  points to it:
  - `pointerError` says the pointer already names an earlier run: that
    earlier run stays the export. Send both runs' `prefix` and
    `manifestSha256` to the coordinator. Only if the coordinator picks this
    run, run again with `"replacePointer":true`.
  - `pointerError` says reading the pointer back failed: ask for links by
    `frozenAt`. If their prefix is this run's, the pointer is this run's and
    all is well. If not, it names an earlier run: do as in the case above,
    and fetch this run by its `prefix`.
  - Any other `pointerError` ("The pointer write failed", with the error's
    code or name only): send the coordinator this run's `prefix` and
    `manifestSha256`, and fetch fresh links by `prefix`, not `frozenAt`.
- `endpoint` is `reader`, with `readOnly: true` and `evidence`: the export
  read DB_HOST_READ. `evidence.transactionReadOnly` is true, and
  `serverReadOnly` or `innodbReadOnly` is true. The reader's hostname is in
  neither the response nor the manifest (whose `read.endpoint` is the same
  label); it is only in the function's log, as `[READ REPLICA ...]`.
- `bucketPrivacy.owner` is the function's own account.
- `snapshotAt` and `snapshotGapMs`: the snapshot came at least 120 000 ms
  after the freeze (`snapshotGapSeconds` is the same, rounded).
- `evidence.replicaLagMs` plus `evidence.replicaLagAgeMs`, plus 1 500 ms,
  is below `snapshotGapMs`, and `replicaLagCase` and `replicaLagAccepted`
  are `null`. Otherwise both name the case accepted, which must be in
  `acceptUnknownReplicaLag` and be the case Monday showed; any lag the row
  reported, plus 1 500 ms, is still below `snapshotGapMs`.
- `latestSiteWrites` (publication, archive and pointer change) and
  `writesAfterFreeze`: no site writes after the freeze, except those listed
  in `acceptedWritesAfterFreeze`.
- `identityFreezeAtReading` is `time` and `identityFreezeAt` equals
  `frozenAt`.
- `seconds`.
- `presignedManifestUrl`, `presignedLinksUrl` and `linksLastAtMost`.
  `links.json` holds a presigned link for every object of the run:
  `cms-fields.json`, `report.json`, each `files/<cid>`, and the manifest.
  The manifest lists `links.json` with its size and sha256; `linksBytes` is
  its size too.

Everything in the bucket, the pointer included, expires 30 days after it
was written. Within the links' 6 hours, the coordinator downloads a complete
copy of the real export and keeps it with `out.json`: every file in the
links file, the manifest included, and the pointer. These commands download
everything and check every file's sha256 against the manifest. They work
for `links-out.json` from the links job too: put its name in place of
`out.json`. Start in an empty folder, beside `out.json`: each run's files
go into their own `profile-site-export-<run>/`, the pointer included, so a
rehearsal's files never mix with Tuesday's.

PowerShell:

```text
$ErrorActionPreference = 'Stop'
& {
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $ProgressPreference = 'SilentlyContinue'
  $out = Get-Content out.json -Raw | ConvertFrom-Json
  $run = Split-Path (Split-Path $out.manifestKey -Parent) -Leaf
  $dir = "profile-site-export-$run"
  New-Item -ItemType Directory -Force "$dir\files" | Out-Null
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
macOS):

```text
j() { jq -r "$@" | tr -d '\r'; }
run=$(basename "$(dirname "$(j .manifestKey out.json)")"); dir="profile-site-export-$run"; mkdir -p "$dir/files"
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
`aws s3 cp --recursive s3://<bucket>/<prefix> ./profile-site-export-<run>/`.

Every `files/<cid>` is at most 2 MiB, the chain's document limit, since each
becomes a chain document. `cms-fields.json`, `report.json`, `links.json` and
the manifest are read by the import's builder and by people, never stored on
the chain, so they have no such limit. `links.json` grows with every file
and can pass 2 MiB; that is expected.

### Fresh links for an earlier run

Links last at most 6 hours, and can stop sooner: they last no longer than
the credentials that signed them. For a fresh set, name the run by its
freeze (the stage's pointer finds it):

```text
$env:AWS_MAX_ATTEMPTS='1'
Set-Content -Encoding ascii links-event.json '{"job":"profileSiteExportLinks","frozenAt":"2026-11-24T00:00:00Z"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 120 --cli-binary-format raw-in-base64-out --payload file://links-event.json links-out.json
```

or by its prefix:

```text
Set-Content -Encoding ascii links-event.json '{"job":"profileSiteExportLinks","prefix":"<prefix from out.json>"}'
```

Give one or the other. By freeze, it refuses if the manifest's sha256 is no
longer the one the pointer names. `links-out.json` carries `manifestSha256`
too, and, by freeze, `presignedPointerUrl`.

The fresh links file goes beside the run, under
`profile-site-export/<stage>/renewed-links/<run>/`, never in the run's
folder, which keeps only what its manifest lists.

## When a run fails

A failed run returns a function error and leaves no manifest. The CLI then
prints `"FunctionError": "Unhandled"` with its `StatusCode`, and `out.json`
holds the `errorMessage`. Run it again; every run has its own prefix.

When the read replica itself fails (a connection, a login, a `SELECT`),
`errorMessage` says "The read replica failed" and gives only the error's
code and number, such as `ER_ACCESS_DENIED_ERROR 1045`: the server's
message can name the user and host. Any other network call that fails (an
S3 upload, a stored record's gateway, the public API) says "A network call
failed", again with the code only. A DNS failure (`EAI_AGAIN`,
`ENOTFOUND`) on either says "DNS lookup failed, retry" with its code, and
never the host: run it again. An AWS service's refusal (S3, Secrets
Manager) says "An AWS call was refused" with its name and HTTP status,
such as `AccessDenied (403)`. A failed public API request is written into
`report.json` as `request_failed: <code>`. The full messages are in the
function's log, as `[READ REPLICA FAILED]`, `[NETWORK CALL FAILED]`,
`[AWS CALL REFUSED]` and `[PUBLIC API REQUEST FAILED]`.

### If the CLI fails

A CLI failure is not a run failure. The CLI waits up to 960 s for the
answer, but a NAT can drop a connection idle for 350 s. The CLI then prints
an error of its own (a read timeout, or a closed connection) and no
`StatusCode`, and leaves no `out.json`, while the run goes on and may
finish.

If the CLI failed and printed no `FunctionError`:

1. Don't run it again.
2. Wait 15 minutes from the start: by then the run has ended.
3. For a real run, ask for its links by `frozenAt` (see "Fresh links for an
   earlier run"). If `links-out.json`'s prefix starts with this run's start
   time (`profile-site-export/prod/<UTC start time>-...`), this run
   finished and its pointer was written. If it names an earlier run, or
   says there is no run for that freeze, this run may still have finished
   with a manifest but no pointer: read the logs, as below.
4. For a rehearsal (it has no pointer), read the logs.

The `[EXPORT DONE]` line gives the run's prefix, its manifest's name and
sha256, its pointer (or `NOT WRITTEN`) and its seconds. Then ask for links
by that `prefix`.

Reading the logs needs `logs:FilterLogEvents` on `/aws/lambda/dbDumpsDaily`;
ask the deploy lead if you don't have it.

```text
$since = [DateTimeOffset]::UtcNow.AddHours(-1).ToUnixTimeMilliseconds()
aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/dbDumpsDaily --start-time $since --filter-pattern "EXPORT DONE" --query "events[].message" --output text
```

bash:

```text
aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/dbDumpsDaily --start-time "$(( ($(date +%s) - 3600) * 1000 ))" --filter-pattern "EXPORT DONE" --query "events[].message" --output text
```

No `[EXPORT DONE]` line within the hour means the run didn't finish: run it
again.

### Other failures

- The function keeps one invocation at a time (reserved concurrency 1) and
  runs the daily dump at 01:00 UTC. A call made while another run or the dump
  is going is refused as throttled (`TooManyRequestsException`); call again
  when it ends.
- A run has the function's 15 minutes. It logs the profile count at the
  start, then its progress every 25 profiles. With less than a minute left
  it stops before the next profile, the next attempt at a stored record
  (a retry included), or the public API check, with an error that says how
  far it got, and writes no manifest. Then see Monday's timing run for what
  follows.
- The export reaches the stored publication records (IPFS and Arweave
  gateways) and an Ethereum RPC for Safe signatures, as the CLI does. So the
  function's VPC subnets need outbound internet access, as the other loops
  that fetch from the network have.
