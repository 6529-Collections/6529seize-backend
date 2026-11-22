# Identity export job

The identity export (`6529 run identity:export`) also runs as a job of the
`dbDumpsDaily` function. It follows the rules in [README.md](README.md):
- it reads the read replica only;
- it writes the owned private bucket only, naming the expected owner on
  every call and sending a SHA-256 checksum with every upload;
- it writes the manifest last.

Invoke it as the README says. Use AWS CLI v2 and always pass `--region`.
Put the event in a file and pass it as `file://event.json`, because inline
JSON loses its quotes in PowerShell 5.1.

The event carries the CLI's options, under the same rules.

## The event

| Field | CLI | Notes |
| --- | --- | --- |
| `job` | | `identityExport` |
| `freezeAt` or `noFreeze: true` | `--freeze-at` or `--no-freeze` | 00:00 UTC, as ISO UTC (`2026-11-24T00:00:00Z`) or 13-digit Unix milliseconds. When `IDENTITY_FREEZE_AT` is set, it must be the same time |
| `expectTdhBlock` | `--expect-tdh-block` | required with `freezeAt` |
| `revision` | `--revision` | the 40-hex commit of the backend the function runs |
| `extraIds` or `noExtraIds: true` | `--extra-ids` or `--no-extra-ids` | `{ "key": "<object key>" }` or `{ "inline": [...] }`: profile ids (UUIDs) |
| `cmsFields` or `noCmsFields: true` | `--cms-fields` or `--no-cms-fields` | `{ "key": "<object key>" }` or `{ "inline": {...} }` |
| `bulk` | `--bulk` | default 2000 |
| `noDelegations: true` | `--no-delegations` | |
| `acceptOverCredit`, `acceptEditsAfterFreeze`, `acceptRatingsChangedAfterFreeze`, `acceptProfileWritesAfterFreeze`, `acceptMissingExtraIds`, `acceptUnmatchedCms` | `--accept-*` | each the exact count a refused run reported; only with `expectTdhBlock` |
| `acceptSnapshotGapMinutes` | | with `freezeAt` only: accepts a snapshot more than 90 minutes after the freeze |

Unknown fields are refused. An input's key must be an object in the chain
exports bucket, under one of two prefixes:
- `identity-export/`, for the waves list you put there;
- `profile-site-export/`, for a profile site export run's
  `cms-fields.json`.

An inline input is hashed as its JSON text.

The job refuses, and writes nothing, in these cases:
- `freezeAt` is not `IDENTITY_FREEZE_AT`;
- the snapshot was taken before the freeze, or more than 90 minutes after
  it, unless `acceptSnapshotGapMinutes` covers the gap;
- the database is not at the freeze day, or a count is not acknowledged
  exactly. The error names every reason, with the CLI's exit code;
- less than a minute of the function's time is left. The error names the
  step reached.

A run writes these objects under
`identity-export/<prod|staging>/<time>-<request>[-rehearsal]/`:
- `identity-export.json`: the file the import's builder reads;
- `summary.json`: the header, rules, stats and notes;
- `links.json`;
- the manifest, written last.

The manifest is `manifest.json` only for a run at the freeze. A rehearsal
(`noFreeze`) writes `manifest.unusable.json`, so it can't be taken for the
import. The manifest records:
- the scope (inputs and options);
- `IDENTITY_FREEZE_AT`;
- the snapshot's time, and its gap from the freeze;
- the size and sha256 of every object, `links.json` included.

After a `manifest.json`, the job writes a pointer,
`identity-export/<stage>/by-freeze/<freezeAt>.json`. It names the run's
prefix, its manifest, and the export's key and sha256. A later run for the
same freeze replaces it.

## Staging rehearsal (eu-west-1)

PowerShell 5.1:

```text
Set-Content -Encoding ascii event.json '{"job":"identityExport","noFreeze":true,"revision":"<40-hex commit deployed to staging>","noExtraIds":true,"noCmsFields":true}'
aws lambda invoke --region eu-west-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

## Monday: the production timing run, no freeze (us-east-1)

This run reads the whole production replica to time Tuesday's export. It
writes only `manifest.unusable.json`. Put the waves list at
`identity-export/inputs/waves.json` first, or use `noExtraIds`.

```text
Set-Content -Encoding ascii event.json '{"job":"identityExport","noFreeze":true,"revision":"<40-hex commit deployed to production>","extraIds":{"key":"identity-export/inputs/waves.json"},"cmsFields":{"key":"profile-site-export/prod/<profile site run>/cms-fields.json"}}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

Read `seconds` in `out.json` and send it to the identity lead. If it is above
about 600, Tuesday's run may not fit one invocation.

## Tuesday: the run at the freeze (us-east-1)

Run it after the freeze day's TDH run and its identities sync have finished.
Start with no acknowledgements. A refused run lists every count. Then add
each one, exactly, and run again:

```text
Set-Content -Encoding ascii event.json '{"job":"identityExport","freezeAt":"2026-11-24T00:00:00Z","expectTdhBlock":<B_T>,"revision":"<40-hex commit deployed to production>","extraIds":{"key":"identity-export/inputs/waves.json"},"cmsFields":{"key":"profile-site-export/prod/<profile site run at the freeze>/cms-fields.json"}}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

After a refusal, add only the fields its error named, with its counts. For
example:
`"acceptOverCredit":<N>,"acceptEditsAfterFreeze":<N>,"acceptRatingsChangedAfterFreeze":<N>,"acceptProfileWritesAfterFreeze":<N>,"acceptMissingExtraIds":<N>,"acceptUnmatchedCms":<N>`.
Start before 01:30 UTC, or add `"acceptSnapshotGapMinutes":<minutes>`.

## What to check in the response (`out.json`)

- `prefix` starts with `identity-export/prod/` (or `/staging/`), with no
  `-rehearsal` for the real run.
- `manifestKey` ends in `manifest.json`, and `usable` is true.
- `pointerKey` is `identity-export/<stage>/by-freeze/<freezeAt>.json`.
- `host`, `readOnly: true` and `evidence`:
  - `transactionReadOnly` is true;
  - `serverReadOnly` or `innodbReadOnly` is true.
- `bucketPrivacy.owner` is the function's own account.
- `frozenAt` equals `identityFreezeAt`.
- `snapshotAt` and `snapshotGapSeconds`.
- `identities`, `ratings` and `tdhBlock`.
- `seconds`.
- `presignedManifestUrl`, `presignedLinksUrl` and `linksLastAtMost`. The
  links end sooner if the signing session ends first.

`identityExportLinks` with the run's `prefix` gives fresh links:

```text
Set-Content -Encoding ascii links-event.json '{"job":"identityExportLinks","prefix":"<prefix from out.json>"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 120 --cli-binary-format raw-in-base64-out --payload file://links-event.json links-out.json
```
