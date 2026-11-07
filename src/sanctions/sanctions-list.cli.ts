import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import {
  checkKrPinnedDocument,
  fetchSanctionsSource,
  FetchedSource
} from '@/sanctions/sanctions-fetch';
import {
  readSanctionsInputs,
  writeSanctionsInputs
} from '@/sanctions/sanctions-inputs';
import { buildSanctionsList } from '@/sanctions/sanctions-list-builder';
import { diffSanctionsLists } from '@/sanctions/sanctions-list-diff';
import {
  SANCTIONS_SOURCE_IDS,
  SanctionsListV1
} from '@/sanctions/sanctions-list.types';
import { S3Client } from '@aws-sdk/client-s3';
import axios from 'axios';
import {
  awsKmsSigningClient,
  KmsReleaseSigner
} from '@/sanctions/kms-release-signer';
import {
  publishSanctionsRelease,
  s3SanctionsStore,
  singleSignerKeys
} from '@/sanctions/sanctions-publisher';
import {
  SANCTIONS_PAYLOAD_PATH,
  SanctionsKeysV1,
  SanctionsReleaseEnvelope,
  verifySanctionsRelease
} from '@/sanctions/sanctions-release';

const HELP = `Usage: 6529 run sanctions:list <command> [options]

Commands:
  fetch --out <dir>                 Download every official source into <dir>
  build --in <dir> --out <dir>      Build the canonical list from fetched inputs
        [--previous <payload.json>] and diff it against an earlier payload
  run --dir <dir> [--previous <f>]  fetch into <dir>/inputs, build into <dir>/output
  publish --in <dir> --bucket <name> --region <region> --kms-key <id or alias>
                                    Build from fetched inputs, sign with KMS and
                                    publish under sanctions/v1/ (skips unchanged)
  verify --url <base> --keyid <0x address>
                                    Fetch latest/release.json and the payload from
                                    <base> (e.g. https://host/sanctions/v1) and
                                    verify them against the pinned key

The build is deterministic: the same inputs always give the same bytes.
`;

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
}

function requiredValue(args: string[], name: string): string {
  const value = option(args, name);
  if (value === null || value.trim() === '') {
    throw new Error(`Missing ${name}

${HELP}`);
  }
  return value.trim();
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === null) {
    throw new Error(`Missing ${name}\n\n${HELP}`);
  }
  return path.resolve(value);
}

async function fetchAll(outDir: string) {
  const fetched: FetchedSource[] = [];
  for (const source of SANCTIONS_SOURCE_IDS) {
    process.stderr.write(`fetching ${source}\n`);
    fetched.push(await fetchSanctionsSource(source));
  }
  const krCheck = await checkKrPinnedDocument();
  mkdirSync(outDir, { recursive: true });
  return writeSanctionsInputs(outDir, fetched, [krCheck]);
}

function build(inDir: string, outDir: string, previousPath: string | null) {
  const { manifest, inputs } = readSanctionsInputs(inDir);
  const result = buildSanctionsList(inputs);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, SANCTIONS_PAYLOAD_PATH), result.bytes);
  const previous = previousPath
    ? (JSON.parse(readFileSync(previousPath, 'utf8')) as SanctionsListV1)
    : null;
  const summary = {
    sha256: result.sha256,
    cid: result.cid,
    bytes: result.bytes.length,
    totals: result.list.totals,
    sources: result.list.sources.map((source) => ({
      id: source.id,
      source_published: source.source_published,
      evm_addresses: source.evm_addresses,
      listings: source.listings,
      inputs: source.inputs
    })),
    unattributed: result.report.filter((item) => item.unattributed.length > 0),
    pinned_document_checks: manifest.checks,
    diff: previous ? diffSanctionsLists(previous, result.list) : null
  };
  writeFileSync(
    path.join(outDir, 'build-report.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return summary;
}

async function publish(args: string[]) {
  const { inputs } = readSanctionsInputs(required(args, '--in'));
  const result = buildSanctionsList(inputs);
  const region = requiredValue(args, '--region');
  const signer = await KmsReleaseSigner.create(
    awsKmsSigningClient(region),
    requiredValue(args, '--kms-key')
  );
  const published = await publishSanctionsRelease({
    build: result,
    store: s3SanctionsStore(
      new S3Client({ region }),
      requiredValue(args, '--bucket')
    ),
    signer,
    now: new Date()
  });
  return {
    published: published.published,
    sequence: published.sequence,
    sha256: published.sha256,
    cid: result.cid,
    signer: signer.address,
    totals: result.list.totals
  };
}

async function verify(args: string[]) {
  const base = requiredValue(args, '--url').replace(/\/+$/, '');
  const keyid = requiredValue(args, '--keyid').toLowerCase();
  const get = async (url: string) =>
    (
      await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
        validateStatus: (status) => status === 200
      })
    ).data;
  const envelope = JSON.parse(
    Buffer.from(await get(`${base}/latest/release.json`)).toString('utf8')
  ) as SanctionsReleaseEnvelope;
  const payload = Buffer.from(
    await get(`${base}/latest/${SANCTIONS_PAYLOAD_PATH}`)
  );
  const published = JSON.parse(
    Buffer.from(await get(`${base}/keys.json`)).toString('utf8')
  ) as SanctionsKeysV1;
  const pinned = singleSignerKeys(keyid);
  const result = verifySanctionsRelease(envelope, pinned, payload, {
    now: new Date()
  });
  return {
    ...result,
    sha256: envelope.signed.payload.sha256,
    cid: envelope.signed.payload.cid,
    published_keys_match_pinned:
      JSON.stringify(published.roles.sanctions.keys) ===
      JSON.stringify(pinned.roles.sanctions.keys)
  };
}

export async function main(args: string[] = process.argv.slice(2)) {
  const [command, ...rest] = args;
  switch (command) {
    case 'fetch': {
      const manifest = await fetchAll(required(rest, '--out'));
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    case 'build': {
      const previous = option(rest, '--previous');
      const summary = build(
        required(rest, '--in'),
        required(rest, '--out'),
        previous ? path.resolve(previous) : null
      );
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    case 'run': {
      const dir = required(rest, '--dir');
      const previous = option(rest, '--previous');
      await fetchAll(path.join(dir, 'inputs'));
      const summary = build(
        path.join(dir, 'inputs'),
        path.join(dir, 'output'),
        previous ? path.resolve(previous) : null
      );
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    case 'publish':
      process.stdout.write(`${JSON.stringify(await publish(rest), null, 2)}
`);
      return;
    case 'verify':
      process.stdout.write(`${JSON.stringify(await verify(rest), null, 2)}
`);
      return;
    default:
      process.stdout.write(HELP);
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
