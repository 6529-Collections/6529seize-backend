import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { readSanctionsInputs } from '@/sanctions/sanctions-inputs';
import {
  buildSanctionsList,
  SanctionsSourceInputs
} from '@/sanctions/sanctions-list-builder';
import {
  readSanctionsVector,
  SANCTIONS_SPEC_DIR
} from '@/sanctions/sanctions-spec-files';

interface BuilderVector {
  sha256: string;
  cid: string;
  bytes: number;
  totals: { addresses: number; listings: number; sources: number };
  report: Array<{
    source: string;
    evm_addresses: number;
    listings: number;
    unattributed: string[];
  }>;
}

const FIXTURE_INPUTS = path.join(SANCTIONS_SPEC_DIR, 'fixtures', 'inputs');
const EXPECTED_PAYLOAD = path.join(
  SANCTIONS_SPEC_DIR,
  'fixtures',
  'expected',
  'sanctions-list.v1.json'
);

const vector = readSanctionsVector<BuilderVector>('builder.json');

function fixtureInputs(): SanctionsSourceInputs[] {
  return readSanctionsInputs(FIXTURE_INPUTS).inputs;
}

describe('buildSanctionsList', () => {
  it('reproduces the expected payload bytes for the fixtures', () => {
    const result = buildSanctionsList(fixtureInputs());
    expect(result.bytes.equals(readFileSync(EXPECTED_PAYLOAD))).toBe(true);
    expect(result.sha256).toBe(vector.sha256);
    expect(result.cid).toBe(vector.cid);
    expect(result.bytes.length).toBe(vector.bytes);
    expect(result.list.totals).toEqual(vector.totals);
    expect(result.report).toEqual(vector.report);
  });

  it('does not depend on the order of sources, files or listings', () => {
    const reference = buildSanctionsList(fixtureInputs()).sha256;
    const reversed = fixtureInputs()
      .reverse()
      .map((input) => ({ ...input, files: input.files.slice().reverse() }));
    expect(buildSanctionsList(reversed).sha256).toBe(reference);
  });

  it('gives identical bytes on every run', () => {
    const first = buildSanctionsList(fixtureInputs());
    const second = buildSanctionsList(fixtureInputs());
    expect(second.bytes.equals(first.bytes)).toBe(true);
  });

  it('requires every source exactly once', () => {
    const inputs = fixtureInputs();
    expect(() =>
      buildSanctionsList(inputs.filter((input) => input.source !== 'ca-sema'))
    ).toThrow(/ca-sema exactly once/);
    expect(() => buildSanctionsList(inputs.concat(inputs[0]))).toThrow(
      /exactly once/
    );
  });

  it('rejects unknown sources', () => {
    const inputs = fixtureInputs();
    expect(() =>
      buildSanctionsList(
        inputs.concat({ source: 'xx-test' as never, files: [] })
      )
    ).toThrow(/Unknown sanctions source/);
  });

  it('enforces nothing outside the official inputs', () => {
    const { list } = buildSanctionsList(fixtureInputs());
    const sources = new Set(list.sources.map((source) => source.id));
    for (const entry of list.addresses) {
      for (const listing of entry.listings) {
        expect(sources.has(listing.source)).toBe(true);
      }
    }
  });
});

describe('readSanctionsInputs', () => {
  let copy: string;

  beforeEach(() => {
    copy = mkdtempSync(path.join(tmpdir(), 'sanctions-inputs-'));
    cpSync(FIXTURE_INPUTS, copy, { recursive: true });
  });

  afterEach(() => {
    rmSync(copy, { recursive: true, force: true });
  });

  it('reads every source listed in the manifest', () => {
    expect(readSanctionsInputs(copy).inputs).toHaveLength(8);
  });

  it('refuses a file whose bytes changed after it was fetched', () => {
    const file = path.join(copy, 'ca-sema', 'sema-lmes.xml');
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
    expect(() => readSanctionsInputs(copy)).toThrow(/recorded sha256/);
  });

  it('refuses file names that could escape the inputs directory', () => {
    const manifestPath = path.join(copy, 'inputs.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.sources[0].files[0].name = '../inputs.json';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => readSanctionsInputs(copy)).toThrow(/Unsafe input file name/);
  });
});
