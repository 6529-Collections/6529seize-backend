import { createHash } from 'node:crypto';

export interface DossierReader {
  read(path: string): AsyncIterable<Uint8Array>;
}
const validPath = (path: string): boolean =>
  /^[a-zA-Z0-9_.=/-]+$/.test(path) &&
  !path.startsWith('/') &&
  path.split('/').every((part) => !!part && part !== '..' && part !== '.');
async function readMetadata(
  reader: DossierReader,
  path: string
): Promise<Buffer> {
  if (!validPath(path)) throw new Error('Invalid dossier path');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of reader.read(path)) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024)
      throw new Error('Dossier metadata exceeds limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function verify(
  reader: DossierReader,
  path: string,
  expected: string
): Promise<number> {
  if (!validPath(path) || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Invalid dossier manifest');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of reader.read(path)) {
    size += chunk.length;
    if (size > 8 * 1024 ** 3) throw new Error('Dossier file exceeds limit');
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expected)
    throw new Error('Dossier fixity verification failed');
  return size;
}
function manifestLines(bytes: Buffer): [string, string][] {
  const result: [string, string][] = [];
  for (const line of bytes.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9_.=/-]+)$/.exec(line);
    if (!match || !validPath(match[2]))
      throw new Error('Invalid BagIt manifest');
    result.push([match[2], match[1]]);
  }
  if (new Set(result.map(([path]) => path)).size !== result.length)
    throw new Error('Duplicate BagIt payload');
  return result;
}

function pathMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid OCFL manifest');
  const entries = Object.entries(value);
  if (entries.length > 20000)
    throw new Error('Dossier file count exceeds limit');
  for (const [digest, paths] of entries) {
    if (
      !/^[a-f0-9]{64}$/.test(digest) ||
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 20000 ||
      paths.some((path) => typeof path !== 'string' || !validPath(path))
    )
      throw new Error('Invalid OCFL manifest');
  }
  return value as Record<string, string[]>;
}

async function verifyPhysicalContent(
  reader: DossierReader,
  manifest: Record<string, string[]>
) {
  const pathsSeen = new Set<string>();
  let total = 0;
  for (const [digest, paths] of Object.entries(manifest)) {
    for (const path of paths) {
      if (!/^v[1-9]\d*\/content\//.test(path) || pathsSeen.has(path))
        throw new Error('Invalid OCFL content path');
      pathsSeen.add(path);
      if (pathsSeen.size > 20000)
        throw new Error('Dossier file count exceeds limit');
      total += await verify(reader, path, digest);
      if (total > 160 * 1024 ** 3)
        throw new Error('Dossier exceeds reconstruction limit');
    }
  }
}

async function verifyBag(
  logical: Map<string, { physical: string; digest: string }>,
  local: (path: string) => Promise<Buffer>
) {
  if (
    (await local('bagit.txt')).toString() !==
    'BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n'
  )
    throw new Error('Unsupported BagIt declaration');
  const payload = manifestLines(await local('manifest-sha256.txt'));
  const tags = manifestLines(await local('tagmanifest-sha256.txt'));
  const expectedPayload = Array.from(logical.keys()).filter((path) =>
    path.startsWith('bag/data/')
  );
  if (
    payload.length !== expectedPayload.length ||
    payload.some(([path]) => !path.startsWith('data/'))
  )
    throw new Error('Incomplete BagIt payload manifest');
  const expectedTags = Array.from(logical.keys()).filter(
    (path) =>
      !path.startsWith('bag/data/') && path !== 'bag/tagmanifest-sha256.txt'
  );
  if (
    tags.length !== expectedTags.length ||
    tags.some(
      ([path]) => path.startsWith('data/') || path === 'tagmanifest-sha256.txt'
    )
  )
    throw new Error('Incomplete BagIt tag manifest');
  for (const [path, digest] of [...payload, ...tags]) {
    if (logical.get(`bag/${path}`)?.digest !== digest)
      throw new Error('BagIt and OCFL digests disagree');
  }
}

/** Reconstructs the complete draft without the database. Does not restore permissions or claim an imported signature. */
export async function reconstructDossier(reader: DossierReader) {
  if (
    (await readMetadata(reader, '0=ocfl_object_1.1')).toString() !==
    'ocfl_object_1.1\n'
  )
    throw new Error('Unsupported OCFL object');
  const inventoryBytes = await readMetadata(reader, 'inventory.json');
  const expected = (
    await readMetadata(reader, 'inventory.json.sha256')
  ).toString();
  const inventoryHash = createHash('sha256')
    .update(inventoryBytes)
    .digest('hex');
  if (expected !== `${inventoryHash} inventory.json\n`)
    throw new Error('OCFL inventory digest mismatch');
  const inventory = JSON.parse(inventoryBytes.toString()) as {
    id: string;
    type: string;
    digestAlgorithm: string;
    head: string;
    manifest: Record<string, string[]>;
    versions: Record<string, { state: Record<string, string[]> }>;
  };
  if (
    inventory.type !== 'https://ocfl.io/1.1/spec/#inventory' ||
    inventory.digestAlgorithm !== 'sha256' ||
    !/^v[1-9]\d*$/.test(inventory.head) ||
    !inventory.versions ||
    !inventory.versions[inventory.head]
  )
    throw new Error('Unsupported OCFL inventory');
  if (
    !(await readMetadata(reader, `${inventory.head}/inventory.json`)).equals(
      inventoryBytes
    ) ||
    (
      await readMetadata(reader, `${inventory.head}/inventory.json.sha256`)
    ).toString() !== expected
  )
    throw new Error('OCFL head inventory mismatch');
  const manifest = pathMap(inventory.manifest);
  await verifyPhysicalContent(reader, manifest);
  const logical = new Map<string, { physical: string; digest: string }>();
  for (const [digest, paths] of Object.entries(
    pathMap(inventory.versions[inventory.head].state)
  )) {
    const physical = manifest[digest]?.[0];
    if (!physical || !validPath(physical))
      throw new Error('Missing OCFL content');
    for (const path of paths) {
      if (
        !validPath(path) ||
        !path.startsWith('bag/') ||
        logical.has(path) ||
        logical.size >= 20000
      )
        throw new Error('Invalid OCFL logical state');
      logical.set(path, { physical, digest });
    }
  }
  const local = async (path: string): Promise<Buffer> => {
    const entry = logical.get(`bag/${path}`);
    if (!entry) throw new Error('Incomplete artwork dossier');
    const bytes = await readMetadata(reader, entry.physical);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.digest)
      throw new Error('Dossier fixity verification failed');
    return bytes;
  };
  await verifyBag(logical, local);
  const record = JSON.parse(
    (await local('data/record.json')).toString()
  ) as Record<string, unknown>;
  if (
    record.schema !== 'STREAM_ARTWORK_DOSSIER_DRAFT_V1' ||
    inventory.id !== `urn:uuid:${record.work_id}`
  )
    throw new Error('Artwork identity mismatch');
  const museumRecords = JSON.parse(
    (await local('data/museum-records.json')).toString()
  ) as unknown[];
  return {
    record,
    museum_records: museumRecords,
    files: Array.from(logical.entries()).map(([path, value]) => ({
      path,
      sha256: value.digest,
      physical_path: value.physical
    })),
    permissions_restored: false,
    signatures_verified: false
  };
}
