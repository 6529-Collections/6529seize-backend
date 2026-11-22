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
- holds the snapshot to the freeze. It refuses a snapshot taken before
  `frozenAt` or more than 90 minutes after it, unless `acceptSnapshotGapMinutes`
  allows more. In a real run it also refuses when `frozenAt` differs from
  `IDENTITY_FREEZE_AT`, or when the snapshot holds a site publication or
  pointer change after `frozenAt`;
- writes only to the private bucket `6529-chain-exports-<account>-<region>`
  under its own prefix. Every call names the function's own account as the
  bucket's expected owner, and every upload carries a SHA-256 checksum S3
  verifies. Before every run it checks that the bucket blocks all public
  access and that S3 calls its policy private;
- writes its manifest last, with the size and sha256 of every object
  (`links.json` included), so a run that stops early has none;
- returns presigned download links, valid for at most 6 hours.

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

PowerShell 5.1:

```text
Set-Content -Encoding ascii event.json '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

bash:

```text
printf '%s' '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z"}' > event.json
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

## Profile site export

Event fields:

- `frozenAt` (required): the freeze, as ISO UTC or 13-digit Unix
  milliseconds. In a real run it must equal `IDENTITY_FREEZE_AT`.
- `rehearsal` (optional, `true`): a timed rehearsal that is never imported.
  Its prefix ends in `-rehearsal`, and its manifest is
  `manifest.unusable.json`. It doesn't require `IDENTITY_FREEZE_AT`, and it
  records site publications after `frozenAt` instead of refusing them.
- `concurrency` (optional, 1 to 4; default 1): profiles exported at once, so
  their stored publication records are fetched in parallel. The output is
  the same at any setting.
- `profile` (optional): one profile id only. Its prefix ends in
  `-profile-<id>`, and its manifest is `manifest.partial.json`.
- `publicApi` (optional): an https base URL to check exported primaries
  against, as the CLI's `--public-api`.
- `acceptSnapshotGapMinutes` (optional): allow a snapshot taken up to this
  many minutes after `frozenAt`. Without it the limit is 90.

Unknown fields are refused.

### Monday: the production timing run

This run says whether Tuesday's export fits the function's 15 minutes.

```text
Set-Content -Encoding ascii rehearsal.json '{"job":"profileSiteExport","frozenAt":"<UTC time a few minutes ago, e.g. 2026-11-23T15:55:00Z>","rehearsal":true}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://rehearsal.json out.json
```

Read `seconds` in `out.json`, and send it to the identity lead.

- If `seconds` is above about 600, run it again with `"concurrency":4` and
  compare.
- If it is still above about 600, Tuesday's run doesn't fit one invocation.
  Then the export runs from a checkout on a machine with database access, by
  a person the coordinator arranges. No lane logs into a database.

The staging rehearsal is the same with `--region eu-west-1`.

### Tuesday: the real run, ~00:00 UTC

```text
Set-Content -Encoding ascii event.json '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z","concurrency":4}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

Drop `"concurrency":4` if Monday's run at 1 was well inside the time. Start
before 01:30 UTC, or add `"acceptSnapshotGapMinutes":N`.

### What to check in the response (`out.json`)

- `prefix` starts with `profile-site-export/prod/` (or `/staging/`) for the
  stage you meant, and has no `-rehearsal` or `-profile-` part for the real
  run.
- `manifestKey` ends in `manifest.json` and `usable` is true. Otherwise the
  run is not the export:
  - `manifest.unusable.json`: a rehearsal, or a stored publication record
    couldn't be fetched. Run again.
  - `manifest.partial.json`: one profile only.
- `pointerKey` is set: `profile-site-export/<stage>/by-freeze/<frozenAt>.json`
  names this run's prefix. A later full run for the same freeze replaces it.
- `host`, `readOnly: true` and `evidence`: the replica it read.
  `evidence.transactionReadOnly` is true, and `serverReadOnly` or
  `innodbReadOnly` is true.
- `bucketPrivacy.owner` is the function's own account.
- `snapshotAt`, `snapshotGapSeconds` and `latestSiteWrites`: the snapshot
  came after the freeze, and holds no site writes after it.
- `identityFreezeAt` equals `frozenAt`.
- `seconds`.
- `presignedManifestUrl`, `presignedLinksUrl` and `linksLastAtMost`.
  `links.json` holds a presigned link for every object of the run:
  `cms-fields.json`, `report.json`, each `files/<cid>`, and the manifest.
  The manifest lists `links.json` with its sha256.

To fetch the files, download `links.json`, then each link in it. Check each
file against the manifest's `sha256`. Anyone with read access to the bucket
can also use
`aws s3 cp --recursive s3://<bucket>/<prefix> ./profile-site-export/`.

Every `files/<cid>` is at most 2 MiB, the chain's document limit, since each
becomes a chain document. `cms-fields.json`, `report.json`, `links.json` and
the manifest are read by the import's builder and by people, never stored on
the chain, so they have no such limit.

### Fresh links for an earlier run

Links last at most 6 hours, and can stop sooner: they last no longer than
the credentials that signed them. For a fresh set:

```text
Set-Content -Encoding ascii links-event.json '{"job":"profileSiteExportLinks","prefix":"<prefix from out.json>"}'
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 120 --cli-binary-format raw-in-base64-out --payload file://links-event.json links-out.json
```

## When a run fails

A failed run returns a function error and leaves no manifest. Run it again;
every run has its own prefix.

- The function keeps one invocation at a time (reserved concurrency 1) and
  runs the daily dump at 01:00 UTC. A call made while another run or the dump
  is going is refused as throttled (`TooManyRequestsException`); call again
  when it ends.
- A run has the function's 15 minutes. It logs the profile count at the
  start, then its progress every 25 profiles. With less than a minute left
  it stops before the next profile, the next fetch of a stored record, or
  the public API check, with an error that says how far it got, and writes
  no manifest. Then see Monday's timing run for what follows.
- The export reaches the stored publication records (IPFS and Arweave
  gateways) and an Ethereum RPC for Safe signatures, as the CLI does. So the
  function's VPC subnets need outbound internet access, as the other loops
  that fetch from the network have.
