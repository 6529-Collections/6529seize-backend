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
        quoted_drop: part.quoted_drop_id
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

/**
 * A Waves v1 file with no rows that commits `dropArchiveRoot`: its header
 * and ten empty lists. For tests of the reader's checks only; a chain's
 * import file holds the rows.
 */
export function wavesFileCommitting(
  root: string,
  freezeMs = 1_764_000_000_000
): Buffer {
  const header = Buffer.alloc(2 + 2 + 8 + 20 + 32 + 32 + 32 + 1 + 16 + 40);
  header.writeUInt16BE(WAVES_FILE_SCHEMA, 0);
  header.writeUInt16BE(WAVES_FILE_VERSION, 2);
  header.writeBigUInt64BE(BigInt(freezeMs), 4);
  Buffer.from(root.slice(2), 'hex').copy(header, 96);
  // mainStage 0 and an empty decision; ten zero counts, then ten empty lists.
  return Buffer.concat([header, Buffer.alloc(40)]);
}
