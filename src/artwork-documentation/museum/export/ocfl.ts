import { createHash } from 'node:crypto';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import { DossierSnapshot, DossierTextFile } from './dossier.types';
import { compileDossier } from './dossier';

export const OCFL_BAG_PREFIX = 'v1/content/bag/';
const file = (path: string, content: string): DossierTextFile => {
  const bytes = Buffer.from(content, 'utf8');
  return {
    path,
    bytes,
    media_type: 'text/plain',
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
};

/** A complete BagIt bag is the logical content of an independently valid OCFL 1.1 object. */
export function wrapDossierInOcfl(
  snapshot: DossierSnapshot,
  dossier: ReturnType<typeof compileDossier>
) {
  const manifest: Record<string, string[]> = {};
  const state: Record<string, string[]> = {};
  const entries = [
    ...dossier.files.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256
    })),
    ...dossier.manifest.filter(
      (entry) =>
        !dossier.files.some((candidate) => candidate.path === entry.path)
    )
  ];
  for (const entry of entries) {
    (manifest[entry.sha256] ??= []).push(`${OCFL_BAG_PREFIX}${entry.path}`);
    (state[entry.sha256] ??= []).push(`bag/${entry.path}`);
  }
  const inventory = {
    id: `urn:uuid:${snapshot.context.work_id}`,
    type: 'https://ocfl.io/1.1/spec/#inventory',
    digestAlgorithm: 'sha256',
    head: 'v1',
    contentDirectory: 'content',
    manifest,
    versions: {
      v1: {
        created: new Date(Number(snapshot.context.updated_at))
          .toISOString()
          .replace('.000Z', 'Z'),
        message: `Portable artwork draft ${snapshot.context.draft_version}; prior artist confirmation is retained within the record.`,
        state
      }
    }
  };
  const inventoryFile = file(
    'inventory.json',
    canonicalizeJson(inventory) + '\n'
  );
  const sidecar = `${inventoryFile.sha256} inventory.json\n`;
  return {
    prefix: OCFL_BAG_PREFIX,
    inventory,
    files: [
      file('0=ocfl_object_1.1', 'ocfl_object_1.1\n'),
      inventoryFile,
      file('inventory.json.sha256', sidecar),
      file('v1/inventory.json', inventoryFile.bytes.toString('utf8')),
      file('v1/inventory.json.sha256', sidecar),
      ...dossier.files.map((entry) => ({
        ...entry,
        path: OCFL_BAG_PREFIX + entry.path
      }))
    ]
  };
}
