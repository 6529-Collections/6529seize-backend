import {
  DropArchiveLeaf,
  dropArchiveRoot,
  keccak256Hex,
  legacyDerivedId,
  readWavesFileHeader,
  WAVE_KIND
} from '@/waves-import-files/drop-archive.format';
import {
  DropArchiveDropRow,
  DropArchiveLineError,
  DropArchivePartRow,
  dropArchiveRows
} from '@/waves-import-files/drop-archive.rows';

/**
 * Reads 6529.io's drops from before the waves switch out of the drop
 * archives the chain committed, and writes them as `drops` and
 * `drops_parts` rows. Nothing is written that the chain does not fix:
 *
 * 1. The Waves v1 file's keccak256 must be the file hash of the chain's
 *    waves import.
 * 2. The archive index's (wave id, hash) list must give the file's
 *    `dropArchiveRoot`, so the index is the committed list.
 * 3. Each archive's wave id must be its 6529.io wave's chain id, and its
 *    keccak256 the hash the index lists.
 * 4. Each line must be a v1 drop of that wave, and no drop id may repeat.
 *
 * An archive that fails a check is refused and counted, and none of its
 * rows are written; the caller fails when the count is above 0. A file or
 * root that fails refuses everything. Ids, serials and times are the
 * archive's. Drops of members-only waves go into the same tables, whose
 * readers enforce 6529.io's member access; the reader logs no content.
 */

/** Where the chain's waves import is read. */
export interface DropArchiveChain {
  /** The imported Waves v1 file's keccak256 (0x and 64 hex), or null before the import completed. */
  importedFileHash(): Promise<string | null>;
}

/** Where the files are read: null for a file the source doesn't have. */
export interface DropArchiveFiles {
  wavesFile(): Promise<Uint8Array | null>;
  /** The snapshot tooling's archive index (archives/index.json). */
  archiveIndex(): Promise<Uint8Array | null>;
  /** The archive of a wave, by its chain wave id (0x and 64 hex). */
  archive(waveId: string): Promise<Uint8Array | null>;
}

export interface DropArchiveWriter {
  write(
    drops: DropArchiveDropRow[],
    parts: DropArchivePartRow[]
  ): Promise<void>;
}

export interface DropArchiveRefusal {
  /** The archive's chain wave id, or null for the file or the index. */
  readonly waveId: string | null;
  readonly reason: string;
}

export interface DropArchiveReport {
  readonly wavesFileHash: string | null;
  readonly dropArchiveRoot: string | null;
  /** Archives the index lists. */
  readonly archives: number;
  /** Archives written. */
  readonly written: number;
  readonly drops: number;
  readonly parts: number;
  readonly refused: readonly DropArchiveRefusal[];
}

/** One index entry, as the snapshot tooling's archives/index.json lists it. */
interface IndexEntry {
  readonly waveId: string;
  readonly legacyWave: string;
  readonly hash: string;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
/** Rows a write takes at most. */
export const WRITE_BATCH = 500;

function parseIndex(bytes: Uint8Array): IndexEntry[] {
  const json = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  const archives = (json as { archives?: unknown })?.archives;
  if (!Array.isArray(archives)) {
    throw new Error('the archive index has no archives list');
  }
  return archives.map((value: unknown, index) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    const waveId = `0x${String(entry.waveId ?? '').replace(/^0x/, '')}`;
    const hash = `0x${String(entry.hash ?? '').replace(/^0x/, '')}`;
    if (
      !HEX32.test(waveId) ||
      !HEX32.test(hash) ||
      typeof entry.legacyWave !== 'string'
    ) {
      throw new Error(`archive index entry ${index + 1} is malformed`);
    }
    return { waveId, hash, legacyWave: entry.legacyWave };
  });
}

const NEWLINE = 0x0a;

type ArchiveRows = { drop: DropArchiveDropRow; parts: DropArchivePartRow[] };

/**
 * An archive read line by line over its bytes (the largest archives are
 * hundreds of megabytes, more than one string may hold). `next()` gives
 * the next line's rows, or null after the last line; it throws
 * DropArchiveLineError, naming the line, when a line is not a v1 drop of
 * the wave.
 */
class ArchiveCursor {
  private readonly buffer: Buffer;
  private start = 0;
  private line = 0;

  constructor(
    bytes: Uint8Array,
    private readonly legacyWave: string
  ) {
    this.buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const last = this.buffer.length - 1;
    if (last >= 0 && this.buffer[last] !== NEWLINE) {
      throw new DropArchiveLineError('the archive does not end with a newline');
    }
  }

  next(): ArchiveRows | null {
    if (this.start >= this.buffer.length) return null;
    const end = this.buffer.indexOf(NEWLINE, this.start);
    this.line++;
    let value: unknown;
    try {
      value = JSON.parse(this.buffer.toString('utf8', this.start, end));
    } catch {
      throw new DropArchiveLineError(`line ${this.line} is not JSON`);
    }
    this.start = end + 1;
    try {
      return dropArchiveRows(value, this.legacyWave);
    } catch (error) {
      if (error instanceof DropArchiveLineError) {
        throw new DropArchiveLineError(`line ${this.line}: ${error.message}`);
      }
      throw error;
    }
  }
}

/** Drop ids and serials of the archives already taken. */
interface Taken {
  readonly ids: Set<string>;
  readonly serials: Set<number>;
}

/**
 * Why the archive can't be written, or null when every line is a drop of
 * its wave and no drop id or serial repeats, here or in an archive already
 * taken (`taken`, which gets this archive's when it is taken).
 */
function lineProblem(
  bytes: Uint8Array,
  legacyWave: string,
  taken: Taken
): string | null {
  const ids = new Set<string>();
  const serials = new Set<number>();
  try {
    const cursor = new ArchiveCursor(bytes, legacyWave);
    let rows = cursor.next();
    while (rows) {
      const { id, serial_no } = rows.drop;
      if (ids.has(id) || taken.ids.has(id)) {
        return 'a drop id appears twice';
      }
      if (serials.has(serial_no) || taken.serials.has(serial_no)) {
        return 'a serial number appears twice';
      }
      ids.add(id);
      serials.add(serial_no);
      rows = cursor.next();
    }
  } catch (error) {
    if (error instanceof DropArchiveLineError) return error.message;
    throw error;
  }
  ids.forEach((id) => taken.ids.add(id));
  serials.forEach((serial) => taken.serials.add(serial));
  return null;
}

async function writeArchive(
  bytes: Uint8Array,
  legacyWave: string,
  writer: DropArchiveWriter
): Promise<{ drops: number; parts: number }> {
  let drops: DropArchiveDropRow[] = [];
  let parts: DropArchivePartRow[] = [];
  let dropCount = 0;
  let partCount = 0;
  const flush = async () => {
    if (!drops.length) return;
    await writer.write(drops, parts);
    dropCount += drops.length;
    partCount += parts.length;
    drops = [];
    parts = [];
  };
  const cursor = new ArchiveCursor(bytes, legacyWave);
  let rows = cursor.next();
  while (rows) {
    drops.push(rows.drop);
    parts.push(...rows.parts);
    if (drops.length >= WRITE_BATCH || parts.length >= WRITE_BATCH * 4) {
      await flush();
    }
    rows = cursor.next();
  }
  await flush();
  return { drops: dropCount, parts: partCount };
}

/** Reads, checks and writes every archive; see the module comment. */
export async function importDropArchives({
  chain,
  files,
  writer,
  log = () => undefined
}: {
  chain: DropArchiveChain;
  files: DropArchiveFiles;
  writer: DropArchiveWriter;
  log?: (message: string) => void;
}): Promise<DropArchiveReport> {
  const refused: DropArchiveRefusal[] = [];
  const report = (
    fields: Partial<DropArchiveReport> = {}
  ): DropArchiveReport => ({
    wavesFileHash: null,
    dropArchiveRoot: null,
    archives: 0,
    written: 0,
    drops: 0,
    parts: 0,
    refused,
    ...fields
  });
  const imported = await chain.importedFileHash();
  if (imported === null) {
    refused.push({
      waveId: null,
      reason: 'the chain has no completed waves import'
    });
    return report();
  }
  const file = await files.wavesFile();
  if (!file) {
    refused.push({ waveId: null, reason: 'the Waves v1 file is missing' });
    return report();
  }
  const fileHash = keccak256Hex(file);
  if (fileHash !== imported.toLowerCase()) {
    refused.push({
      waveId: null,
      reason: `the Waves v1 file hashes to ${fileHash}, the chain imported ${imported}`
    });
    return report({ wavesFileHash: fileHash });
  }
  let committed: string;
  try {
    committed = readWavesFileHeader(file).dropArchiveRoot;
  } catch (error) {
    refused.push({ waveId: null, reason: (error as Error).message });
    return report({ wavesFileHash: fileHash });
  }
  const indexBytes = await files.archiveIndex();
  let index: IndexEntry[];
  try {
    if (!indexBytes) throw new Error('the archive index is missing');
    index = parseIndex(indexBytes);
  } catch (error) {
    refused.push({ waveId: null, reason: (error as Error).message });
    return report({ wavesFileHash: fileHash, dropArchiveRoot: committed });
  }
  const leaves: DropArchiveLeaf[] = index.map(({ waveId, hash }) => ({
    waveId,
    hash
  }));
  const ascending = leaves.every(
    (leaf, i) => i === 0 || leaves[i - 1].waveId < leaf.waveId
  );
  const root = dropArchiveRoot(leaves);
  if (!ascending || root !== committed) {
    refused.push({
      waveId: null,
      reason: ascending
        ? `the archive index gives root ${root}, the Waves v1 file commits ${committed}`
        : 'the archive index is not ascending by wave id'
    });
    return report({
      wavesFileHash: fileHash,
      dropArchiveRoot: committed,
      archives: index.length
    });
  }
  log(
    `Waves v1 file ${fileHash} is the chain's import; ${index.length} archives under root ${committed}`
  );
  const taken: Taken = { ids: new Set(), serials: new Set() };
  let written = 0;
  let drops = 0;
  let parts = 0;
  for (const entry of index) {
    const refuse = (reason: string) => {
      refused.push({ waveId: entry.waveId, reason });
      log(`Refused archive ${entry.waveId}: ${reason}`);
    };
    if (legacyDerivedId(entry.legacyWave, WAVE_KIND) !== entry.waveId) {
      refuse('its wave id is not its 6529.io wave chain id');
      continue;
    }
    const bytes = await files.archive(entry.waveId);
    if (!bytes) {
      refuse('the archive is missing');
      continue;
    }
    const hash = keccak256Hex(bytes);
    if (hash !== entry.hash) {
      refuse(`it hashes to ${hash}, the root commits ${entry.hash}`);
      continue;
    }
    const problem = lineProblem(bytes, entry.legacyWave, taken);
    if (problem) {
      refuse(problem);
      continue;
    }
    const count = await writeArchive(bytes, entry.legacyWave, writer);
    written++;
    drops += count.drops;
    parts += count.parts;
  }
  log(
    `Wrote ${drops} drops and ${parts} parts from ${written} archives; refused ${refused.length}`
  );
  return report({
    wavesFileHash: fileHash,
    dropArchiveRoot: committed,
    archives: index.length,
    written,
    drops,
    parts
  });
}
