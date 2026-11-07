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
import { SANCTIONS_PAYLOAD_PATH } from '@/sanctions/sanctions-release';

const HELP = `Usage: 6529 run sanctions:list <command> [options]

Commands:
  fetch --out <dir>                 Download every official source into <dir>
  build --in <dir> --out <dir>      Build the canonical list from fetched inputs
        [--previous <payload.json>] and diff it against an earlier payload
  run --dir <dir> [--previous <f>]  fetch into <dir>/inputs, build into <dir>/output

The build is deterministic: the same inputs always give the same bytes.
`;

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : null;
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
