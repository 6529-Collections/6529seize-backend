import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FILE_INDEX } from '@/rebuild/sources/file-server';

/**
 * The token metadata of the holdings seed's cards, as content-addressed
 * files. Each file's id is the base64url SHA-256 of its bytes, 43 characters
 * like an Arweave id, and a card's token URI names it on arweave.net. The
 * seed writes them into the run's seed files directory, and the check's
 * files source serves them (DECENTRALIZED_MEDIA_FILES_URL).
 */

export const SEED_ARTIST = 'Seed Artist';

function memesCard(card: number, edition = '') {
  return {
    name: `Seed Card ${card}`,
    description: `Card ${card} of the rebuild check's holdings seed.${edition}`,
    image: `https://arweave.net/${placeholderId(`image-${card}${edition}`)}`,
    image_details: { format: 'PNG', width: 1000, height: 1000 },
    attributes: [
      { trait_type: 'Artist', value: SEED_ARTIST },
      { trait_type: 'SEIZE Artist Profile', value: 'seed-artist' },
      { trait_type: 'Meme Name', value: `Seed ${card}` },
      { trait_type: 'Type - Season', value: 1 },
      { trait_type: 'Type - Meme', value: card },
      { trait_type: 'Type - Card', value: card }
    ]
  };
}

function memeLabCard(card: number) {
  return {
    name: `Seed Lab Card ${card}`,
    description: `Meme Lab card ${card} of the rebuild check's holdings seed.`,
    image: `https://arweave.net/${placeholderId(`lab-image-${card}`)}`,
    image_details: { format: 'PNG', width: 1000, height: 1000 },
    attributes: [
      { trait_type: 'Artist', value: SEED_ARTIST },
      { trait_type: 'Collection', value: 'Seed Collection' },
      { trait_type: 'Website', value: 'None' }
    ]
  };
}

function nextGenToken(tokenId: number) {
  return {
    name: `Seed Pebble #${tokenId}`,
    description: "A token of the rebuild check's NextGen collection.",
    image: `https://arweave.net/${placeholderId(`nextgen-image-${tokenId}`)}`,
    attributes: [
      { trait_type: 'Palette', value: 'Blue' },
      { trait_type: 'Shape', value: 'Round' }
    ]
  };
}

/** An id for a file nothing fetches (images: the seed queues no media). */
function placeholderId(name: string): string {
  return createHash('sha256').update(name).digest('base64url');
}

function file(document: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return {
    id: createHash('sha256').update(bytes).digest('base64url'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes
  };
}

/** The seed's metadata files, by role. */
export const SEED_FILES = {
  memes: [1, 2, 3].map((card) => file(memesCard(card))),
  /** Card 4, made by a Manifold claim; its location names this file. */
  memesClaimCard: file(memesCard(4)),
  /** Card 1's metadata after its token URI changes. */
  memesCard1Changed: file(memesCard(1, ' Its second edition.')),
  memeLab: [1].map((card) => file(memeLabCard(card))),
  /**
   * The NextGen collection's one token. Its base URI names this file, and
   * the files source serves it for every path under it.
   */
  nextGenToken: file(nextGenToken(10_000_000_000))
};

export const seedTokenUri = (seedFile: { id: string }) =>
  `https://arweave.net/${seedFile.id}`;

/** Every file the seed's tokens name. */
export function seedFiles(): { id: string; sha256: string; bytes: Buffer }[] {
  return [
    ...SEED_FILES.memes,
    SEED_FILES.memesCard1Changed,
    SEED_FILES.memesClaimCard,
    ...SEED_FILES.memeLab,
    SEED_FILES.nextGenToken
  ];
}

/**
 * Writes every file into `dir` and lists each in the directory's
 * files.json (id to hex SHA-256), keeping what other seeds listed there.
 */
export function writeSeedFiles(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, FILE_INDEX);
  const index: Record<string, string> = fs.existsSync(indexFile)
    ? JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    : {};
  for (const file of seedFiles()) {
    fs.writeFileSync(path.join(dir, file.id), file.bytes);
    index[file.id] = file.sha256;
  }
  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
}
