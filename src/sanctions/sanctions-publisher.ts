import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import type { SanctionsListBuild } from '@/sanctions/sanctions-list-builder';
import { diffSanctionsLists } from '@/sanctions/sanctions-list-diff';
import type {
  SanctionsListV1,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';
import {
  createSanctionsRelease,
  EIP191_SECP256K1,
  SANCTIONS_KEYS_SCHEMA,
  SANCTIONS_PAYLOAD_PATH,
  SanctionsKeysV1,
  SanctionsReleaseEnvelope,
  SanctionsReleaseSigner,
  verifySanctionsRelease
} from '@/sanctions/sanctions-release';

/**
 * Publishes signed releases under `<prefix>/` (spec section 3.3):
 *   releases/<seq>/{sanctions-list.v1.json,release.json}  immutable
 *   diffs/<prev>-<seq>.json                                immutable
 *   latest/{sanctions-list.v1.json,release.json}           short cache
 *   index.json, status.json                                short cache
 * `keys.json` (the trust root) is written by an administrator, never here.
 */

export const SANCTIONS_INDEX_SCHEMA = '6529.sanctions-index.v1';
export const SANCTIONS_STATUS_SCHEMA = '6529.sanctions-status.v1';
export const SANCTIONS_POLICY = {
  id: '6529.io/sanctions-policy',
  version: '1'
};

const JSON_TYPE = 'application/json; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';
const STATUS_CACHE = 'public, max-age=60';
const DEFAULT_VALIDITY_DAYS = 14;

export interface SanctionsObjectStore {
  getText(key: string): Promise<string | null>;
  put(
    key: string,
    body: string,
    options: { cacheControl: string }
  ): Promise<void>;
}

export function s3SanctionsStore(
  client: S3Client,
  bucket: string
): SanctionsObjectStore {
  return {
    async getText(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        return response.Body ? await response.Body.transformToString() : null;
      } catch (error) {
        if (
          error instanceof NoSuchKey ||
          (error as { name?: string }).name === 'NoSuchKey'
        ) {
          return null;
        }
        throw error;
      }
    },
    async put(key, body, { cacheControl }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: JSON_TYPE,
          CacheControl: cacheControl
        })
      );
    }
  };
}

export interface SanctionsIndexEntry {
  readonly sequence: number;
  readonly sha256: string;
  readonly cid: string;
  readonly bytes: number;
  readonly published_at: string;
  readonly totals: SanctionsListV1['totals'];
  readonly sources: Partial<Record<SanctionsSourceId, number>>;
}

export interface SanctionsIndexV1 {
  readonly schema: typeof SANCTIONS_INDEX_SCHEMA;
  readonly releases: SanctionsIndexEntry[];
}

export interface SanctionsPublishResult {
  readonly published: boolean;
  readonly sequence: number;
  readonly sha256: string;
  readonly envelope: SanctionsReleaseEnvelope | null;
}

function utcSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Keys file naming exactly the given signers, threshold 1 (single signer today). */
export function singleSignerKeys(address: string): SanctionsKeysV1 {
  return {
    schema: SANCTIONS_KEYS_SCHEMA,
    roles: {
      sanctions: {
        threshold: 1,
        keys: [{ keyid: address.toLowerCase(), method: EIP191_SECP256K1 }]
      }
    }
  };
}

async function readIndex(
  store: SanctionsObjectStore,
  prefix: string
): Promise<SanctionsIndexV1> {
  const text = await store.getText(`${prefix}/index.json`);
  if (text === null) {
    return { schema: SANCTIONS_INDEX_SCHEMA, releases: [] };
  }
  const index = JSON.parse(text) as SanctionsIndexV1;
  if (
    index.schema !== SANCTIONS_INDEX_SCHEMA ||
    !Array.isArray(index.releases)
  ) {
    throw new Error('Published index has an unexpected shape');
  }
  return index;
}

function indexEntry(
  build: SanctionsListBuild,
  sequence: number,
  publishedAt: string
): SanctionsIndexEntry {
  const sources: Partial<Record<SanctionsSourceId, number>> = {};
  for (const source of build.list.sources) {
    sources[source.id] = source.evm_addresses;
  }
  return {
    sequence,
    sha256: build.sha256,
    cid: build.cid,
    bytes: build.bytes.length,
    published_at: publishedAt,
    totals: build.list.totals,
    sources
  };
}

async function writeStatus(
  store: SanctionsObjectStore,
  prefix: string,
  build: SanctionsListBuild,
  latest: { sequence: number; sha256: string },
  checkedAt: string,
  changed: boolean
): Promise<void> {
  await store.put(
    `${prefix}/status.json`,
    json({
      schema: SANCTIONS_STATUS_SCHEMA,
      checked_at: checkedAt,
      changed,
      latest_sequence: latest.sequence,
      latest_sha256: latest.sha256,
      sources: build.list.sources.map((source) => ({
        id: source.id,
        source_published: source.source_published
      }))
    }),
    { cacheControl: STATUS_CACHE }
  );
}

/**
 * Signs and publishes a build when its bytes differ from the latest release;
 * otherwise only refreshes `status.json`. The new release is verified against
 * the signer's key before anything is written, and immutable files are
 * written before the `latest` pointers, so readers never see a pointer to a
 * missing file.
 */
export async function publishSanctionsRelease(params: {
  readonly build: SanctionsListBuild;
  readonly store: SanctionsObjectStore;
  readonly signer: SanctionsReleaseSigner;
  readonly now: Date;
  readonly prefix?: string;
  readonly validityDays?: number;
}): Promise<SanctionsPublishResult> {
  const { build, store, signer, now } = params;
  const prefix = params.prefix ?? 'sanctions/v1';
  const checkedAt = utcSeconds(now);
  const index = await readIndex(store, prefix);
  const last =
    index.releases.length > 0
      ? index.releases[index.releases.length - 1]
      : null;

  if (last !== null && last.sha256 === build.sha256) {
    await writeStatus(store, prefix, build, last, checkedAt, false);
    return {
      published: false,
      sequence: last.sequence,
      sha256: last.sha256,
      envelope: null
    };
  }

  const sequence = (last?.sequence ?? 0) + 1;
  const validityDays = params.validityDays ?? DEFAULT_VALIDITY_DAYS;
  const envelope = await createSanctionsRelease(
    {
      payloadBytes: build.bytes,
      sequence,
      publishedAt: checkedAt,
      expiresAt: utcSeconds(
        new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000)
      ),
      previous: last ? { sequence: last.sequence, sha256: last.sha256 } : null,
      policy: SANCTIONS_POLICY
    },
    [signer]
  );
  verifySanctionsRelease(
    envelope,
    singleSignerKeys(signer.address),
    build.bytes,
    {
      now,
      minSequence: last?.sequence
    }
  );

  const payload = build.bytes.toString('utf8');
  const releaseText = json(envelope);
  const releaseDir = `${prefix}/releases/${sequence}`;
  await store.put(`${releaseDir}/${SANCTIONS_PAYLOAD_PATH}`, payload, {
    cacheControl: IMMUTABLE
  });
  await store.put(`${releaseDir}/release.json`, releaseText, {
    cacheControl: IMMUTABLE
  });
  if (last !== null) {
    const previousText = await store.getText(
      `${prefix}/releases/${last.sequence}/${SANCTIONS_PAYLOAD_PATH}`
    );
    if (previousText !== null) {
      const diff = diffSanctionsLists(
        JSON.parse(previousText) as SanctionsListV1,
        build.list
      );
      await store.put(
        `${prefix}/diffs/${last.sequence}-${sequence}.json`,
        json({ from: last.sequence, to: sequence, ...diff }),
        { cacheControl: IMMUTABLE }
      );
    }
  }
  await store.put(`${prefix}/latest/${SANCTIONS_PAYLOAD_PATH}`, payload, {
    cacheControl: SHORT
  });
  await store.put(`${prefix}/latest/release.json`, releaseText, {
    cacheControl: SHORT
  });
  await store.put(
    `${prefix}/index.json`,
    json({
      schema: SANCTIONS_INDEX_SCHEMA,
      releases: index.releases.concat(indexEntry(build, sequence, checkedAt))
    }),
    { cacheControl: SHORT }
  );
  await writeStatus(
    store,
    prefix,
    build,
    { sequence, sha256: build.sha256 },
    checkedAt,
    true
  );
  return { published: true, sequence, sha256: build.sha256, envelope };
}
