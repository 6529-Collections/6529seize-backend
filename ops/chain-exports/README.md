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
  the session in UTC, records the server's clock at the snapshot
  (`snapshot_at`), and refuses a snapshot before the freeze or more than 90
  minutes after it unless the invoker acknowledges the gap;
- writes only to the private bucket `6529-chain-exports-<account>-<region>`
  under its own prefix, checking before every run that the bucket blocks all
  public access and that S3 calls its policy private;
- writes its manifest last, with the size and sha256 of every object, so a
  run that stops early has none;
- returns presigned download links: 6 hours, or less if the credentials that
  signed them end first (`linksExpireAt` says which).

No database password and no long-lived key is handled by a person.

## One-time setup (administrative)

The deployment roles can't create buckets
(`ops/iam/backend-*/README.md`: storage provisioning is administrative), so
the bucket is made once per region with administrative credentials:

```text
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region eu-west-1
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region us-east-1
```

Staging runs in `eu-west-1`, production in `us-east-1`; both are in one
account, so the region is what tells them apart.

The bucket policy allows the function role (`lambda-vpc-role`) to read the
bucket's public access block and policy status, and to put and get objects
under `profile-site-export/` and `identity-export/`. It denies CloudFront's
service principal and plain HTTP. Objects expire after 30 days. In one
account, a bucket policy's Allow adds to what an identity's own policies
grant; it does not narrow them. Identities in the account whose own policies
allow S3 on every bucket can reach this one too, as with any bucket in the
account.

## Why the file is private

- The bucket blocks public ACLs and public policies, and ignores and restricts
  both (`PublicAccessBlockConfiguration`, all four true). S3 refuses any
  public grant on it.
- Its policy names no public principal. It denies CloudFront's service
  principal, which origin access control uses. A legacy origin access
  identity would need an Allow in this policy, and there is none. No
  CloudFront distribution or other definition in this repository names the
  bucket: the only distributions here are the IPFS edge
  (`ops/ipfs/cloudformation/edge.yaml`, its own origins) and the NextGen
  distribution the deployment role may update.
- Every run calls `GetPublicAccessBlock` and `GetBucketPolicyStatus` and
  refuses to write unless all four blocks are on and `IsPublic` is false.
  Each run's response carries `bucketPrivacy`.

The team confirms once:

- the stack was created from this template, in both regions;
- no other policy grants anyone outside the account access to the bucket;
- the account's S3 Block Public Access is on.

## Who invokes

The deployment roles may invoke only `dbMigrationsLoop`, and can't read the
bucket. The invoker needs `lambda:InvokeFunction` on `dbDumpsDaily` in the
region of the stage it runs. The deploy lead reports that its credentials
can invoke functions in both stages; confirm that before Monday, or have an
admin grant it. Fetching the files needs no AWS access: the response's
presigned links are enough.

## Profile site export

Write the event to a file and pass it with `file://`. Inline JSON loses its
quotes in PowerShell 5.1. Always pass `--region`.

`event.json` for Tuesday's run:

```json
{ "job": "profileSiteExport", "frozenAt": "2026-11-24T00:00:00Z" }
```

```text
aws lambda invoke --region us-east-1 --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload file://event.json out.json
```

For a staging rehearsal use `--region eu-west-1`. For a rehearsal, set
`frozenAt` to a UTC time a few minutes before the run: the snapshot may be
at most 90 minutes after it.

Event fields:

- `frozenAt` (required): the freeze, as ISO UTC or 13-digit Unix
  milliseconds.
- `profile` (optional): one profile id only. Its prefix ends in
  `-profile-<id>`.
- `publicApi` (optional): an https base URL to check exported primaries
  against, as the CLI's `--public-api`.
- `acceptSnapshotGapMinutes` (optional): accept a snapshot up to this many
  minutes after the freeze. Without it the limit is 90.

Unknown fields are refused.

Check the response (`out.json`):

- `prefix` starts with `profile-site-export/staging/` or
  `profile-site-export/prod/` for the stage you meant.
- `host`, `readOnly: true` and `evidence`: the replica it read.
  `evidence.transactionReadOnly` is true, and `serverReadOnly` or
  `innodbReadOnly` is true.
- `snapshotAt` and `snapshotGapSeconds`: when the snapshot was taken, after
  the freeze.
- `usable`. When it is false, a stored publication record couldn't be
  fetched, and the run's manifest is `manifest.unusable.json`, never
  `manifest.json`. Don't import it; run again.
- `scope`, `bucket`, `manifestKey`, `files`, `bytes` and `seconds`.
- `presignedManifestUrl`, `presignedLinksUrl` and `linksExpireAt`.
  `links.json` holds a presigned link for every object of the run:
  `cms-fields.json`, `report.json`, each `files/<cid>`, and the manifest.

To fetch the files, download `links.json` and then each link in it. Check
each file against the manifest's `sha256`. Anyone with read access to the
bucket can also use
`aws s3 cp --recursive s3://<bucket>/<prefix> ./profile-site-export/`.

Every `files/<cid>` is at most 2 MiB, the chain's document limit, since each
becomes a chain document. `cms-fields.json`, `report.json`, `links.json` and
the manifest are read by the import's builder and by people, never stored on
the chain, so they have no such limit.

Fresh links for an earlier run, after `linksExpireAt`: put
`{ "job": "profileSiteExportLinks", "prefix": "<prefix from the run>" }` in
`links-event.json` and run:

```text
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
  start and its progress every 25 profiles. With less than a minute left it
  stops with an error that says how far it got, and writes no manifest. Then
  the export has to run by hand.
- The export also reaches the stored publication records (IPFS and Arweave
  gateways) and an Ethereum RPC for Safe signatures, as the CLI does. So the
  function's VPC subnets need outbound internet access, as the other loops
  that fetch from the network have.
