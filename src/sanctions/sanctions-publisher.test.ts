import * as path from 'path';
import { keccak256, toUtf8Bytes, Wallet } from 'ethers';
import { readSanctionsInputs } from '@/sanctions/sanctions-inputs';
import {
  buildSanctionsList,
  SanctionsListBuild
} from '@/sanctions/sanctions-list-builder';
import {
  publishSanctionsRelease,
  SanctionsObjectStore,
  singleSignerKeys
} from '@/sanctions/sanctions-publisher';
import {
  SanctionsReleaseEnvelope,
  SanctionsReleaseSigner,
  verifySanctionsRelease
} from '@/sanctions/sanctions-release';
import { SANCTIONS_SPEC_DIR } from '@/sanctions/sanctions-spec-files';

function memoryStore() {
  const objects: Record<string, { body: string; cacheControl: string }> = {};
  const store: SanctionsObjectStore = {
    async getText(key) {
      return objects[key]?.body ?? null;
    },
    async put(key, body, { cacheControl }) {
      objects[key] = { body, cacheControl };
    }
  };
  return { store, objects };
}

function signer(): SanctionsReleaseSigner {
  const wallet = new Wallet(
    keccak256(toUtf8Bytes('6529-sanctions-test-key-1'))
  );
  return {
    address: wallet.address.toLowerCase(),
    signMessage: (message) => wallet.signMessage(message)
  };
}

function fixtureBuild(): SanctionsListBuild {
  return buildSanctionsList(
    readSanctionsInputs(path.join(SANCTIONS_SPEC_DIR, 'fixtures', 'inputs'))
      .inputs
  );
}

function withoutKoreanEntries(build: SanctionsListBuild): SanctionsListBuild {
  const inputs = readSanctionsInputs(
    path.join(SANCTIONS_SPEC_DIR, 'fixtures', 'inputs')
  ).inputs.filter((input) => input.source !== 'kr-fsc');
  const kr = build.list.sources.find((source) => source.id === 'kr-fsc');
  expect(kr).toBeDefined();
  // Rebuild with an empty Korean transcription to change the payload.
  const pinned = {
    schema: '6529.sanctions-pinned-source.v1',
    source: 'kr-fsc',
    published: '2026-01-14',
    document: {
      title: 't',
      url: 'https://example.invalid',
      sha256: '0',
      bytes: 1,
      format: 'pdf'
    },
    alternate_documents: [],
    review: {},
    entries: []
  };
  return buildSanctionsList(
    inputs.concat({
      source: 'kr-fsc',
      files: [
        {
          name: 'kr-fsc.pinned.json',
          bytes: Buffer.from(JSON.stringify(pinned))
        }
      ]
    })
  );
}

const NOW = new Date('2026-11-07T06:15:00Z');

describe('publishSanctionsRelease', () => {
  it('publishes release 1 with immutable files, latest pointers, index and status', async () => {
    const { store, objects } = memoryStore();
    const build = fixtureBuild();
    const result = await publishSanctionsRelease({
      build,
      store,
      signer: signer(),
      now: NOW
    });
    expect(result).toMatchObject({ published: true, sequence: 1 });
    expect(Object.keys(objects).sort()).toEqual([
      'sanctions/v1/index.json',
      'sanctions/v1/latest/release.json',
      'sanctions/v1/latest/sanctions-list.v1.json',
      'sanctions/v1/releases/1/release.json',
      'sanctions/v1/releases/1/sanctions-list.v1.json',
      'sanctions/v1/status.json'
    ]);
    expect(
      objects['sanctions/v1/releases/1/release.json'].cacheControl
    ).toMatch(/immutable/);
    expect(objects['sanctions/v1/latest/release.json'].cacheControl).toBe(
      'public, max-age=300'
    );
    const payload = Buffer.from(
      objects['sanctions/v1/latest/sanctions-list.v1.json'].body,
      'utf8'
    );
    expect(payload.equals(build.bytes)).toBe(true);
    const envelope = JSON.parse(
      objects['sanctions/v1/latest/release.json'].body
    ) as SanctionsReleaseEnvelope;
    expect(envelope.signed).toMatchObject({
      sequence: 1,
      published_at: '2026-11-07T06:15:00Z',
      expires_at: '2026-11-21T06:15:00Z',
      previous: null
    });
    expect(
      verifySanctionsRelease(
        envelope,
        singleSignerKeys(signer().address),
        payload,
        { now: NOW }
      ).signers
    ).toEqual([signer().address]);
  });

  it('only refreshes status when the build is unchanged', async () => {
    const { store, objects } = memoryStore();
    await publishSanctionsRelease({
      build: fixtureBuild(),
      store,
      signer: signer(),
      now: NOW
    });
    const later = new Date('2026-11-08T06:15:00Z');
    const result = await publishSanctionsRelease({
      build: fixtureBuild(),
      store,
      signer: signer(),
      now: later
    });
    expect(result).toMatchObject({
      published: false,
      sequence: 1,
      envelope: null
    });
    expect(JSON.parse(objects['sanctions/v1/status.json'].body)).toMatchObject({
      checked_at: '2026-11-08T06:15:00Z',
      changed: false,
      latest_sequence: 1
    });
    expect(objects['sanctions/v1/releases/2/release.json']).toBeUndefined();
  });

  it('chains a changed build as the next sequence with a public diff', async () => {
    const { store, objects } = memoryStore();
    const first = fixtureBuild();
    await publishSanctionsRelease({
      build: first,
      store,
      signer: signer(),
      now: NOW
    });
    const second = withoutKoreanEntries(first);
    const result = await publishSanctionsRelease({
      build: second,
      store,
      signer: signer(),
      now: new Date('2026-11-08T06:15:00Z')
    });
    expect(result).toMatchObject({ published: true, sequence: 2 });
    expect(result.envelope?.signed.previous).toEqual({
      sequence: 1,
      sha256: first.sha256
    });
    const diff = JSON.parse(objects['sanctions/v1/diffs/1-2.json'].body);
    expect(diff).toMatchObject({
      from: 1,
      to: 2,
      removed: ['0x1313131313131313131313131313131313131313']
    });
    const index = JSON.parse(objects['sanctions/v1/index.json'].body);
    expect(
      index.releases.map((entry: { sequence: number }) => entry.sequence)
    ).toEqual([1, 2]);
  });

  it('never writes the trust root', async () => {
    const { store, objects } = memoryStore();
    await publishSanctionsRelease({
      build: fixtureBuild(),
      store,
      signer: signer(),
      now: NOW
    });
    expect(objects['sanctions/v1/keys.json']).toBeUndefined();
  });
});
