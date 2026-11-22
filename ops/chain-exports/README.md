# Chain exports

The two exports the 6529 chain's import reads run inside 6529.io's account as
jobs of the `dbDumpsDaily` function, invoked by hand. The function's schedule
sends no `job`, so the daily dump is unchanged. Each export:

- reads only the read replica (`DB_HOST_READ`, refused when it is the primary's
  `DB_HOST`), in one `START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY`
  with the session in UTC, and logs the host;
- writes only to the private bucket `6529-chain-exports-<account>-<region>`
  under its own prefix, checking before every run that the bucket blocks all
  public access and that S3 calls its policy private;
- writes its manifest last, so a run that stops early has none;
- returns presigned download links (6 hours, or less if the function role's
  session ends first).

No database password and no long-lived key is handled by a person.

## One-time setup (administrative)

The deployment roles can't create buckets
(`ops/iam/backend-*/README.md`: storage provisioning is administrative), so
the bucket is made once per region with administrative credentials:

```text
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region eu-west-1
aws cloudformation deploy --stack-name chain-exports-bucket --template-file ops/chain-exports/chain-exports-bucket.yaml --region us-east-1
```

Staging runs in `eu-west-1`, production in `us-east-1`. The template's bucket
policy grants the function role (`lambda-vpc-role`) only these: reading the
bucket's public access block and policy status, and putting and getting
objects under `profile-site-export/` and `identity-export/`. It denies
CloudFront and plain HTTP. Objects expire after 30 days.

## Why the file is private

- The bucket blocks public ACLs and public policies, and ignores and restricts
  both (`PublicAccessBlockConfiguration`, all four true). S3 refuses any
  public grant on it.
- Its policy names no public principal and denies `cloudfront.amazonaws.com`,
  so no distribution can serve it, even one later pointed at it.
- No CloudFront distribution or other definition in this repository names the
  bucket. The repo's only distributions are the IPFS edge
  (`ops/ipfs/cloudformation/edge.yaml`, its own origins) and the NextGen
  distribution the deployment role may update.
- Every run calls `GetPublicAccessBlock` and `GetBucketPolicyStatus` and
  refuses to write unless all four blocks are on and `IsPublic` is false.
  Each run's response carries `bucketPrivacy`.

What the team confirms once: the stack was created from this template, in
both regions; and no account-level setting or other policy grants anyone else
access to the bucket. The account's S3 Block Public Access should also be on.

## Profile site export

```text
aws lambda invoke --function-name dbDumpsDaily --cli-read-timeout 960 --cli-binary-format raw-in-base64-out --payload '{"job":"profileSiteExport","frozenAt":"2026-11-24T00:00:00Z"}' out.json
```

- `frozenAt`: the freeze (ISO UTC or 13-digit Unix milliseconds). For a
  rehearsal, any time before the run.
- `profile` (optional): one profile id only.
- `publicApi` (optional): an https base URL to check exported primaries
  against, as the CLI's `--public-api`.

The response (`out.json`) carries:

- `host`, `readOnly: true` and `evidence`: the replica it read, and the
  server's own answers (`transactionReadOnly` must be true; `serverReadOnly`
  or `innodbReadOnly` true on a replica);
- `usable`: false when a stored publication record couldn't be fetched (do
  not use that export);
- `bucket`, `prefix` and `manifestKey`, with `files`, `bytes` and `seconds`;
- `presignedManifestUrl` and `presignedLinksUrl`. `links.json` holds a
  presigned link for every object of the run: `cms-fields.json`,
  `report.json`, each `files/<cid>`, and the manifest.

To fetch everything without AWS access, download `links.json` and then each
link in it. With access to the account:
`aws s3 cp --recursive s3://<bucket>/<prefix> ./profile-site-export/`.

Fresh links for an earlier run (after 6 hours):

```text
aws lambda invoke --function-name dbDumpsDaily --cli-read-timeout 120 --cli-binary-format raw-in-base64-out --payload '{"job":"profileSiteExportLinks","prefix":"<prefix from the run>"}' links.json
```

A failed run returns a function error and leaves no manifest. Run it again;
every run has its own prefix.

The function keeps one invocation at a time (reserved concurrency 1) and
runs the daily dump at 01:00 UTC. A call made while another run or the dump
is going is refused as throttled (`TooManyRequestsException`); call again when
it ends. A run has the function's 15 minutes; one that runs out leaves no
manifest.

The export also reaches the stored publication records (IPFS and Arweave
gateways) and an Ethereum RPC for Safe signatures, as the CLI does, so the
function's VPC subnets need outbound internet access, as the other loops
that fetch from the network have.
