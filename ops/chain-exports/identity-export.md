# Identity export job

The identity export (`6529 run identity:export`) also runs as a job of the
`dbDumpsDaily` function. It follows the rules in [README.md](README.md):
the read replica only, the private bucket only, and the manifest written last.
The event carries the CLI's options, and the same rules apply to them.

## The event

| Field | CLI | Notes |
| --- | --- | --- |
| `job` | | `identityExport` |
| `freezeAt` or `noFreeze: true` | `--freeze-at` or `--no-freeze` | ISO UTC (`2026-11-24T00:00:00Z`) or 13-digit Unix milliseconds |
| `expectTdhBlock` | `--expect-tdh-block` | required with `freezeAt` |
| `revision` | `--revision` | the 40-hex commit of the backend the function runs |
| `extraIds` or `noExtraIds: true` | `--extra-ids` or `--no-extra-ids` | `{ "key": "<object key>" }` or `{ "inline": [...] }` |
| `cmsFields` or `noCmsFields: true` | `--cms-fields` or `--no-cms-fields` | `{ "key": "<object key>" }` or `{ "inline": {...} }` |
| `bulk` | `--bulk` | default 2000 |
| `noDelegations: true` | `--no-delegations` | |
| `acceptOverCredit`, `acceptEditsAfterFreeze`, `acceptRatingsChangedAfterFreeze`, `acceptMissingExtraIds` | `--accept-*` | each must be the exact count a refused run reported |
| `acceptSnapshotGapMinutes` | | with `freezeAt` only: accepts a snapshot more than 90 minutes after the freeze |

An input's key must be an object in the chain exports bucket, under
`identity-export/` (put the waves list there) or `profile-site-export/` (a
profile site export run's `cms-fields.json`). An inline input is hashed as its
JSON text.

The job refuses, and writes nothing, in these cases:
- a snapshot taken before the freeze, or more than 90 minutes after it, unless
  `acceptSnapshotGapMinutes` covers the gap;
- a database not at the freeze day, or a count not acknowledged exactly. The
  error names every reason, with the CLI's exit code;
- less than a minute of the function's time left. The error names the step
  reached.

A run writes these objects under
`identity-export/<prod|staging>/<time>-<request>[-rehearsal]/`:
- `identity-export.json`: the file the import's builder reads;
- `summary.json`: the header, rules, stats and notes;
- `links.json`;
- the manifest, written last.

The manifest is `manifest.json` only for a run at the freeze. A rehearsal
(`noFreeze`) writes `manifest.unusable.json`, so it can't be taken for the
import. The manifest records the scope (inputs and options), the snapshot's
time and its gap from the freeze, and the size and sha256 of every object.

Invoke it as the README shows: `--region`, `--cli-read-timeout 960`, and the
payload in a file (`--payload file://event.json`). Check in the response:
- `host` is the replica;
- `evidence.serverReadOnly` or `evidence.innodbReadOnly` is true;
- `usable`;
- `snapshotGapSeconds`;
- `linksExpireAt`.
`identityExportLinks` with the run's `prefix` gives fresh links.

## Staging rehearsal (eu-west-1)

```json
{
  "job": "identityExport",
  "noFreeze": true,
  "revision": "<40-hex commit deployed to staging>",
  "noExtraIds": true,
  "noCmsFields": true
}
```

## Production timing run, no freeze (us-east-1)

This runs the whole export on the production replica to time it. It writes
only `manifest.unusable.json`.

```json
{
  "job": "identityExport",
  "noFreeze": true,
  "revision": "<40-hex commit deployed to production>",
  "extraIds": { "key": "identity-export/inputs/waves.json" },
  "cmsFields": { "key": "profile-site-export/prod/<profile site run>/cms-fields.json" }
}
```

## Tuesday's run at the freeze (us-east-1)

Run it after the freeze day's TDH run and its identities sync have finished.
Give the acknowledgements only as counts the refused run reported; leave out
any that is 0.

```json
{
  "job": "identityExport",
  "freezeAt": "2026-11-24T00:00:00Z",
  "expectTdhBlock": <B_T: the freeze day's TDH block>,
  "revision": "<40-hex commit deployed to production>",
  "extraIds": { "key": "identity-export/inputs/waves.json" },
  "cmsFields": { "key": "profile-site-export/prod/<profile site run at the freeze>/cms-fields.json" },
  "acceptOverCredit": <N from the refusal, or leave out>,
  "acceptEditsAfterFreeze": <N from the refusal, or leave out>,
  "acceptRatingsChangedAfterFreeze": <N from the refusal, or leave out>,
  "acceptMissingExtraIds": <N from the refusal, or leave out>
}
```
