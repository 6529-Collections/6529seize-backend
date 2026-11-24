import { createHash } from 'node:crypto';
import { DropType } from '@/entities/IDrop';
import {
  canonicalJson,
  dropArchiveRoot,
  keccak256Hex,
  legacyDerivedId,
  PRINCIPAL_KIND,
  WAVE_KIND,
  WAVES_FILE_SCHEMA,
  WAVES_FILE_VERSION
} from '@/waves-import-files/drop-archive.format';

/**
 * Drop archives built from 6529.io rows, as the snapshot tooling builds them
 * from the API's drops of those rows (waves_fetch.compact_drop, then
 * waves_model.archive_row): for test worlds and fixtures. It covers the
 * `drops` and `drops_parts` columns; a drop's media, mentions, metadata,
 * NFTs, collaborators, reactions and signed events are written empty.
 */

/** The `drops` columns an archive line is built from. */
export interface DropRowForArchive {
  readonly id: string;
  readonly serial_no: number;
  readonly wave_id: string;
  readonly author_id: string;
  readonly created_at: number;
  readonly updated_at: number | null;
  readonly title: string | null;
  readonly reply_to_drop_id: string | null;
  readonly reply_to_part_id: number | null;
  readonly drop_type: string;
}

/** The `drops_parts` columns an archive line is built from. */
export interface DropPartRowForArchive {
  readonly drop_id: string;
  readonly drop_part_id: number;
  readonly content: string | null;
  readonly quoted_drop_id: string | null;
  readonly quoted_drop_part_id: number | null;
}

/** The archive line (format v1) of one drop and its parts. */
export function archiveLineOf(
  drop: DropRowForArchive,
  parts: readonly DropPartRowForArchive[]
): Record<string, unknown> {
  const principal = legacyDerivedId(drop.author_id, PRINCIPAL_KIND);
  return {
    v: 1,
    drop_id: drop.id,
    serial_no: drop.serial_no,
    wave_id: drop.wave_id,
    author: drop.author_id,
    // The tooling writes the principal's 64 hex digits without 0x.
    author_principal: principal ? principal.slice(2) : null,
    created_at: drop.created_at,
    updated_at: drop.updated_at,
    // The API shows a native entry as PARTICIPATORY.
    drop_type:
      drop.drop_type === DropType.COMPETITION
        ? DropType.PARTICIPATORY
        : drop.drop_type,
    title: drop.title,
    parts: [...parts]
      .sort((a, b) => a.drop_part_id - b.drop_part_id)
      .map((part) => ({
        part_id: part.drop_part_id,
        content: part.content,
        media: [],
        attachments: [],
        // The API shows a quote only with its part id.
        quoted_drop:
          part.quoted_drop_id && part.quoted_drop_part_id
            ? {
                drop_id: part.quoted_drop_id,
                part_id: part.quoted_drop_part_id
              }
            : null
      })),
    metadata: [],
    // The API shows a reply's missing part id as 0.
    reply_to: drop.reply_to_drop_id
      ? {
          drop_id: drop.reply_to_drop_id,
          part_id: drop.reply_to_part_id ?? 0
        }
      : null,
    mentions: { users: [], groups: [], waves: [] },
    nfts: { referenced: [], links: [] },
    collaborators: [],
    reactions: [],
    signed: null
  };
}

/** One archive and its entry in the tooling's archives/index.json. */
export interface BuiltDropArchive {
  /** 0x and 64 lowercase hex digits. */
  readonly waveId: string;
  readonly legacyWave: string;
  readonly bytes: Buffer;
  readonly hash: string;
  readonly drops: number;
}

export interface BuiltDropArchives {
  readonly archives: readonly BuiltDropArchive[];
  /** 0x and 64 lowercase hex digits. */
  readonly dropArchiveRoot: string;
  /** archives/index.json as the tooling writes it (hex without 0x). */
  readonly index: Buffer;
}

/** One archive per wave with drops, lines ascending by serial number. */
export function buildDropArchives(
  drops: readonly DropRowForArchive[],
  parts: readonly DropPartRowForArchive[]
): BuiltDropArchives {
  const partsOf = new Map<string, DropPartRowForArchive[]>();
  for (const part of parts) {
    partsOf.set(part.drop_id, [...(partsOf.get(part.drop_id) ?? []), part]);
  }
  const byWave = new Map<string, DropRowForArchive[]>();
  for (const drop of drops) {
    byWave.set(drop.wave_id, [...(byWave.get(drop.wave_id) ?? []), drop]);
  }
  const archives: BuiltDropArchive[] = [];
  // Array.from: the build targets ES5, where for-of walks arrays only.
  for (const [legacyWave, waveDrops] of Array.from(byWave.entries())) {
    const waveId = legacyDerivedId(legacyWave, WAVE_KIND);
    if (!waveId) throw new Error(`Wave ${legacyWave} has no UUID id`);
    const lines = [...waveDrops]
      .sort((a, b) => a.serial_no - b.serial_no)
      .map(
        (drop) =>
          canonicalJson(archiveLineOf(drop, partsOf.get(drop.id) ?? [])) + '\n'
      );
    const bytes = Buffer.from(lines.join(''), 'utf8');
    archives.push({
      waveId,
      legacyWave,
      bytes,
      hash: keccak256Hex(bytes),
      drops: lines.length
    });
  }
  archives.sort((a, b) => (a.waveId < b.waveId ? -1 : 1));
  const root = dropArchiveRoot(archives);
  const index = {
    dropArchiveRoot: root.slice(2),
    archives: archives.map((archive) => ({
      waveId: archive.waveId.slice(2),
      legacyWave: archive.legacyWave,
      file: `${archive.waveId.slice(2)}.jsonl`,
      drops: archive.drops,
      bytes: archive.bytes.length,
      hash: archive.hash.slice(2)
    })),
    drops: archives.reduce((sum, archive) => sum + archive.drops, 0)
  };
  return {
    archives,
    dropArchiveRoot: root,
    index: Buffer.from(JSON.stringify(index, null, 1), 'utf8')
  };
}

/** A document's raw sha2-256 CIDv1 (P40 5.2), 0x and hex. */
export function rawCidOf(document: Uint8Array): string {
  const digest = createHash('sha256').update(document).digest('hex');
  return `0x01551220${digest}`;
}

/**
 * A Waves v1 file that commits `dropArchiveRoot` and holds only wave rows,
 * one for each of `waves` (its 6529.io id and its document's CID, the
 * rest zero); every other list is empty. For tests of the reader only: a
 * chain's import file holds every row.
 */
export function wavesFileCommitting(
  root: string,
  freezeMs = 1_764_000_000_000,
  waves: readonly { legacyWave: string; documentCid: string }[] = []
): Buffer {
  const header = Buffer.alloc(2 + 2 + 8 + 20 + 32 + 32 + 32 + 1 + 16 + 40);
  header.writeUInt16BE(WAVES_FILE_SCHEMA, 0);
  header.writeUInt16BE(WAVES_FILE_VERSION, 2);
  header.writeBigUInt64BE(BigInt(freezeMs), 4);
  Buffer.from(root.slice(2), 'hex').copy(header, 96);
  // mainStage 0 and an empty decision, then the ten counts (waves third).
  header.writeUInt32BE(waves.length, 2 + 2 + 8 + 20 + 32 * 3 + 1 + 16 + 8);
  const rows = waves.map((wave) => {
    const cid = Buffer.from(wave.documentCid.replace(/^0x/, ''), 'hex');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(cid.length);
    return Buffer.concat([
      Buffer.from(wave.legacyWave.replace(/-/g, ''), 'hex'),
      Buffer.alloc(16 * 4), // controller, read, post and admin groups
      length,
      cid,
      Buffer.from([1]), // status
      Buffer.alloc(8) // created
    ]);
  });
  const count = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([
    header,
    count(0), // groups
    count(0), // members
    count(waves.length),
    ...rows,
    Buffer.alloc(4 * 7) // decisions to wave REP: empty
  ]);
}

/**
 * The wave document a test gives a wave: its description is `parts`
 * (content only, no media).
 */
export function waveDocumentOf(
  legacyWave: string,
  parts: readonly DropPartRowForArchive[]
): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'wave',
      legacy_id: legacyWave,
      description: [...parts]
        .sort((a, b) => a.drop_part_id - b.drop_part_id)
        .map((part) => ({ content: part.content, media: [] }))
    }),
    'utf8'
  );
}

/**
 * A Waves v1 file for built archives: one wave row for each archive's wave,
 * naming the wave's document in `documents` (by 6529.io wave id), or a
 * made-up CID for a wave without one.
 */
export function wavesFileFor(
  built: BuiltDropArchives,
  documents: Readonly<Record<string, Uint8Array>> = {}
): Buffer {
  return wavesFileCommitting(
    built.dropArchiveRoot,
    undefined,
    built.archives.map((archive) => ({
      legacyWave: archive.legacyWave,
      documentCid: rawCidOf(
        documents[archive.legacyWave] ?? Buffer.from(archive.legacyWave)
      )
    }))
  );
}
