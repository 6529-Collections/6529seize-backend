import {
  CONTENT_MODERATION_REPORTS_TABLE,
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_CIPHERTEXT_OBJECTS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';
import { E2EE_RETENTION } from '@/e2ee/e2ee.constants';
import { CrpItem } from '@/e2ee/relay/e2ee-crp';
import {
  isSealedE2eeRecordContent,
  openE2eeRecordContent
} from '@/e2ee/relay/e2ee-moderation-seal';
import {
  decodeE2eeRecordContent,
  E2eeDecodedRecordContent,
  E2eeMissingBytes,
  E2eeRow,
  E2eeRowValue,
  e2eeSha256
} from '@/e2ee/relay/e2ee-record-container';
import {
  checkE2eeRecord,
  E2eeRecordFamily,
  E2eeRecordKind,
  E2eeSignedRecordEvent,
  parseE2eeFamilyWave
} from '@/e2ee/relay/e2ee-record-event';
import {
  E2EE_RECORD_TABLES,
  e2eeRecordKeyString,
  e2eeRecordTable
} from '@/e2ee/relay/e2ee-record-tables';
import { E2eeStreamHead } from '@/e2ee/relay/e2ee-stream-store';
import { ProviderKey } from '@/signed-records/sealed-crypto';

/** The families the delivery service's and the reports' records live in. */
export const E2EE_RECORD_FAMILIES: readonly E2eeRecordFamily[] = [
  'cv',
  'dv',
  'dr',
  'bl',
  'bk',
  'md'
];

/**
 * Resolved reports keep their evidence (snapshot, notes, AI rationale and
 * evidence) this long, as `moderation-review.db.ts` prunes it.
 */
const REPORT_EVIDENCE_MS = 90 * 86_400_000;
/** What the prune leaves in `content_snapshot`, in MySQL's JSON text. */
const EXPIRED_SNAPSHOT = '{"evidence_expired": true}';

/** How a rebuild reads: the orderer's key, the time, the moderation keys. */
export interface E2eeRebuildOptions {
  readonly ordererDeviceKey: string;
  readonly now: number;
  /** Opens the reports sealed to the moderation service key. */
  readonly moderationKeys?: readonly ProviderKey[];
}

/** Where a rebuild reads: the relays (or a fixture). */
export interface E2eeRebuildSource {
  /** Every event of the families, from every relay, once per event id. */
  events(families: readonly string[]): Promise<CrpItem[]>;
  /** Payload bytes by sha256, or null when no relay has them. */
  payload(sha256: string): Promise<Buffer | null>;
}

export interface E2eeRebuildProblem {
  readonly wave: string;
  readonly reason: string;
  readonly pos?: number;
  readonly eventId?: string;
}

/** Rebuilt rows by table, keyed by primary key; heads per stream. */
export interface E2eeRebuiltState {
  readonly tables: Map<string, Map<string, E2eeRow>>;
  readonly heads: E2eeStreamHead[];
  readonly problems: E2eeRebuildProblem[];
  readonly stats: {
    readonly events: number;
    readonly records: number;
    readonly streams: number;
  };
}

interface Located {
  readonly wave: string;
  readonly event: E2eeSignedRecordEvent;
  readonly bytes: Buffer;
  readonly hash: string;
  readonly content: E2eeDecodedRecordContent;
}

type BodyRef = string | { readonly h: string; readonly n: number } | null;

function bodyRefs(event: E2eeSignedRecordEvent): {
  readonly content: BodyRef;
  readonly external: string | null;
} {
  const body = event.body ? JSON.parse(event.body) : null;
  if (!body || typeof body !== 'object')
    return { content: null, external: null };
  if (event.kind === E2eeRecordKind.LOG) {
    return {
      content: body.ds ?? null,
      external: typeof body.data?.h === 'string' ? body.data.h : null
    };
  }
  if (typeof body.c === 'string') return { content: body.c, external: null };
  if (typeof body.h === 'string') {
    return { content: { h: body.h, n: Number(body.n) }, external: null };
  }
  return { content: null, external: null };
}

async function locate(
  item: CrpItem,
  source: E2eeRebuildSource,
  problems: E2eeRebuildProblem[],
  moderationKeys: readonly ProviderKey[]
): Promise<Located | null> {
  const { event } = item;
  const problem = (reason: string) => {
    problems.push({ wave: event.wave, eventId: event.id, reason });
    return null;
  };
  let refs: ReturnType<typeof bodyRefs>;
  try {
    refs = bodyRefs(event);
  } catch {
    return problem('body is not JSON');
  }
  let bytes: Buffer | null = null;
  if (typeof refs.content === 'string') {
    bytes = Buffer.from(refs.content, 'base64url');
  } else if (refs.content) {
    bytes = await source.payload(refs.content.h);
    if (bytes && e2eeSha256(bytes) !== refs.content.h) bytes = null;
  }
  if (!bytes) return problem('content is missing');
  let plain = bytes;
  if (isSealedE2eeRecordContent(bytes)) {
    try {
      plain = openE2eeRecordContent({
        bytes,
        wave: event.wave,
        keys: moderationKeys
      });
    } catch (error) {
      return problem(`sealed content: ${(error as Error).message}`);
    }
  }
  const external = refs.external ? await source.payload(refs.external) : null;
  let content: E2eeDecodedRecordContent;
  try {
    content = decodeE2eeRecordContent(plain, (sha) =>
      sha === refs.external ? external : null
    );
  } catch (error) {
    return problem(`content does not decode: ${(error as Error).message}`);
  }
  if (event.kind === E2eeRecordKind.LOG) {
    const seq = Number(JSON.parse(event.body!).seq);
    if (seq !== content.pos) return problem('LOG seq is not the position');
  }
  return {
    wave: event.wave,
    event,
    bytes,
    hash: e2eeSha256(bytes),
    content
  };
}

/** Orders one stream's records by position and checks the hash chain. */
function chainOf(
  wave: string,
  records: readonly Located[],
  problems: E2eeRebuildProblem[]
): Located[] {
  const byPos = new Map<number, Located[]>();
  for (const record of records) {
    const list = byPos.get(record.content.pos) ?? [];
    if (!list.some((other) => other.hash === record.hash)) list.push(record);
    byPos.set(record.content.pos, list);
  }
  const positions = Array.from(byPos.keys()).sort((a, b) => a - b);
  const chain: Located[] = [];
  let expected = 1;
  for (const pos of positions) {
    if (pos !== expected) {
      problems.push({ wave, pos: expected, reason: 'gap in the stream' });
    }
    expected = pos + 1;
    const candidates = [...byPos.get(pos)!].sort((a, b) =>
      a.hash < b.hash ? -1 : 1
    );
    const previous = chain[chain.length - 1];
    const prevHash =
      previous?.content.pos === pos - 1 ? previous.hash : undefined;
    // With two records at one position (a write rolled back after a relay
    // took its record), the one the next record names is the real one.
    const followed = new Set(
      (byPos.get(pos + 1) ?? []).map((next) => next.content.prev)
    );
    if (candidates.length > 1) {
      problems.push({ wave, pos, reason: 'two records at one position' });
    }
    const chosen =
      candidates.find((candidate) => followed.has(candidate.hash)) ??
      candidates.find((candidate) => candidate.content.prev === prevHash) ??
      candidates[0];
    if (prevHash !== undefined && chosen.content.prev !== prevHash) {
      problems.push({ wave, pos, reason: 'prev does not match' });
    }
    if (pos === 1 && chosen.content.prev !== null) {
      problems.push({ wave, pos, reason: 'first record names a prev' });
    }
    chain.push(chosen);
  }
  return chain;
}

function matchesKey(row: E2eeRow, key: E2eeRow): boolean {
  return Object.entries(key).every(([column, value]) => {
    const current = row[column];
    if (Buffer.isBuffer(value) || Buffer.isBuffer(current)) {
      return (
        Buffer.isBuffer(value) &&
        Buffer.isBuffer(current) &&
        value.equals(current)
      );
    }
    return current === value;
  });
}

class RowStore {
  readonly tables = new Map<string, Map<string, E2eeRow>>();

  constructor(private readonly problems: E2eeRebuildProblem[]) {
    for (const name of Object.keys(E2EE_RECORD_TABLES)) {
      this.tables.set(name, new Map());
    }
  }

  table(name: string): Map<string, E2eeRow> {
    const found = this.tables.get(name);
    if (!found) throw new Error(`Not a recorded table: ${name}`);
    return found;
  }

  apply(record: Located) {
    for (const op of record.content.ops) {
      if (!this.tables.has(op.table)) {
        this.problems.push({
          wave: record.wave,
          pos: record.content.pos,
          reason: `unknown table ${op.table}`
        });
        continue;
      }
      const target = e2eeRecordTable(op.table);
      const rows = this.table(op.table);
      if (op.op === 'put') {
        rows.set(e2eeRecordKeyString(target, op.row), { ...op.row });
        continue;
      }
      if (target.key.every((column) => column in op.key)) {
        rows.delete(e2eeRecordKeyString(target, op.key));
        continue;
      }
      for (const [key, row] of Array.from(rows.entries())) {
        if (matchesKey(row, op.key)) rows.delete(key);
      }
    }
  }

  filter(name: string, keep: (row: E2eeRow) => boolean) {
    const rows = this.table(name);
    for (const [key, row] of Array.from(rows.entries())) {
      if (!keep(row)) rows.delete(key);
    }
  }

  update(name: string, change: (row: E2eeRow) => E2eeRow) {
    const rows = this.table(name);
    for (const [key, row] of Array.from(rows.entries())) {
      rows.set(key, change(row));
    }
  }
}

/**
 * The delivery service's own retention and revocation rules, applied to
 * the replayed rows as MySQL applies them (section 7.2 retention; a revoked
 * device loses its KeyPackages and pending Welcomes). `last_seen_at` is
 * activity, not a record: it becomes the device's latest log item.
 */
function applyRules(
  store: RowStore,
  now: number,
  problems: E2eeRebuildProblem[],
  revokedElsewhere: ReadonlySet<string> = new Set()
) {
  const nowSeconds = Math.floor(now / 1000);
  const devices = store.table(E2EE_DEVICES_TABLE);
  store.filter(
    E2EE_DEVICES_TABLE,
    (row) =>
      row.revoked_at === null ||
      Number(row.revoked_at) >= now - E2EE_RETENTION.revokedDevicesMs
  );
  const revoked = new Set([
    ...Array.from(revokedElsewhere),
    ...Array.from(devices.values())
      .filter((row) => row.revoked_at !== null)
      .map((row) => String(row.device_key))
  ]);
  store.filter(E2EE_LOG_TABLE, (row) => {
    const limit =
      row.item_type === 'message'
        ? E2EE_RETENTION.messagesMs
        : E2EE_RETENTION.entriesMs;
    const expired = Number(row.created_at) < now - limit;
    if (!expired && row.data instanceof E2eeMissingBytes) {
      problems.push({
        wave: `cv/${String(row.group_handle)}`,
        reason: `item ${String(row.seq)} lost its ciphertext before retention`
      });
    }
    return !expired && Buffer.isBuffer(row.data);
  });
  store.filter(
    E2EE_WELCOME_DELIVERIES_TABLE,
    (row) =>
      Number(row.created_at) >= now - E2EE_RETENTION.welcomeDeliveriesMs &&
      !revoked.has(String(row.device_key))
  );
  const delivered = new Set(
    Array.from(store.table(E2EE_WELCOME_DELIVERIES_TABLE).values()).map((row) =>
      String(row.welcome_id)
    )
  );
  store.filter(E2EE_WELCOMES_TABLE, (row) => delivered.has(String(row.id)));
  store.filter(
    E2EE_KEY_PACKAGES_TABLE,
    (row) =>
      Number(row.expires_at_seconds) > nowSeconds &&
      !revoked.has(String(row.device_key))
  );
  store.filter(
    E2EE_BLOBS_TABLE,
    (row) =>
      row.complete === true &&
      Number(row.created_at) >= now - E2EE_RETENTION.blobsMs
  );
  // Rebuilt attachment bytes live in MySQL (the relays keep the originals).
  store.update(E2EE_BLOBS_TABLE, (row) => ({
    ...row,
    storage: 'mysql',
    storage_location: null
  }));
  const blobs = new Set(
    Array.from(store.table(E2EE_BLOBS_TABLE).values()).map((row) =>
      String(row.blob_id)
    )
  );
  store.filter(E2EE_BLOB_CHUNKS_TABLE, (row) => blobs.has(String(row.blob_id)));
  const chunkKeys = new Set(
    Array.from(store.table(E2EE_BACKUP_CHUNKS_TABLE).values()).map((row) =>
      String(row.object_key)
    )
  );
  store.filter(E2EE_CIPHERTEXT_OBJECTS_TABLE, (row) =>
    chunkKeys.has(String(row.object_key))
  );
  const lastSent = new Map<string, number>();
  for (const row of Array.from(store.table(E2EE_LOG_TABLE).values())) {
    const device = String(row.sender_device_key);
    lastSent.set(
      device,
      Math.max(lastSent.get(device) ?? 0, Number(row.created_at))
    );
  }
  store.update(E2EE_DEVICES_TABLE, (row) => ({
    ...row,
    last_seen_at: lastSent.get(String(row.device_key)) ?? null
  }));
  // Reported messages go at retention unless trust and safety holds them.
  store.filter(
    E2EE_REPORTS_TABLE,
    (row) =>
      row.on_hold === true ||
      Number(row.created_at) >= now - E2EE_RETENTION.reportsMs
  );
  store.update(CONTENT_MODERATION_REPORTS_TABLE, (row) =>
    evidenceExpired(row, now)
      ? {
          ...row,
          content_snapshot: EXPIRED_SNAPSHOT,
          notes: null,
          ai_rationale: null,
          ai_evidence: null
        }
      : row
  );
}

/** A resolved report whose evidence the moderation prune clears. */
function evidenceExpired(row: E2eeRow, now: number): boolean {
  if (row.status === 'OPEN' || row.resolved_at === null) return false;
  if (Number(row.resolved_at) >= now - REPORT_EVIDENCE_MS) return false;
  try {
    const snapshot = JSON.parse(String(row.content_snapshot));
    return !(
      snapshot !== null &&
      typeof snapshot === 'object' &&
      'evidence_expired' in snapshot
    );
  } catch {
    return true;
  }
}

/** Checks and locates the orderer's records, grouped by stream. */
async function collect(
  items: readonly CrpItem[],
  source: E2eeRebuildSource,
  options: E2eeRebuildOptions,
  problems: E2eeRebuildProblem[]
): Promise<Map<string, Located[]>> {
  const byWave = new Map<string, Located[]>();
  for (const item of items) {
    const family = parseE2eeFamilyWave(item.event.wave);
    if (!family || item.event.kind === E2eeRecordKind.DEL) continue;
    const check = checkE2eeRecord(item.event, options.ordererDeviceKey);
    if (!check.ok) {
      problems.push({
        wave: item.event.wave,
        eventId: item.event.id,
        reason: `not the orderer's record (${check.reason})`
      });
      continue;
    }
    const located = await locate(
      item,
      source,
      problems,
      options.moderationKeys ?? []
    );
    if (!located) continue;
    const list = byWave.get(located.wave) ?? [];
    list.push(located);
    byWave.set(located.wave, list);
  }
  return byWave;
}

/**
 * Rebuilds the delivery service's tables from the orderer's records on the
 * relays: checks every record's orderer signature, follows each stream's
 * hash chain in position order, replays the row operations, and applies the
 * service's own retention rules at `now`. Nothing is written here.
 */
export async function rebuildE2eeState(
  source: E2eeRebuildSource,
  options: E2eeRebuildOptions
): Promise<E2eeRebuiltState> {
  const problems: E2eeRebuildProblem[] = [];
  const items = await source.events(E2EE_RECORD_FAMILIES);
  const byWave = await collect(items, source, options, problems);
  const store = new RowStore(problems);
  const heads: E2eeStreamHead[] = [];
  let records = 0;
  for (const wave of Array.from(byWave.keys()).sort()) {
    const chain = chainOf(wave, byWave.get(wave)!, problems);
    for (const record of chain) store.apply(record);
    records += chain.length;
    const head = chain[chain.length - 1];
    if (head) heads.push({ wave, pos: head.content.pos, hash: head.hash });
  }
  applyRules(store, options.now, problems);
  return {
    tables: store.tables,
    heads,
    problems,
    stats: { events: items.length, records, streams: heads.length }
  };
}

/** One stream, rebuilt alone: its rows, its head and its problems. */
export interface E2eeRebuiltStream {
  readonly wave: string;
  readonly tables: Map<string, Map<string, E2eeRow>>;
  readonly head: E2eeStreamHead | null;
  readonly problems: E2eeRebuildProblem[];
  readonly records: number;
}

/**
 * Rebuilds one stream from its own records (the per-stream check, which
 * never holds more than one stream in memory). `revokedDevices` names
 * devices whose revocation lives in other streams (their `dr` records), so
 * a device inbox drops a revoked device's Welcomes as the full rebuild does.
 */
export async function rebuildE2eeStream(
  source: E2eeRebuildSource & {
    stream(wave: string): Promise<CrpItem[]>;
  },
  wave: string,
  options: E2eeRebuildOptions & {
    readonly revokedDevices?: ReadonlySet<string>;
  }
): Promise<E2eeRebuiltStream> {
  const problems: E2eeRebuildProblem[] = [];
  const items = (await source.stream(wave)).filter(
    (item) => item.event.wave === wave
  );
  const byWave = await collect(items, source, options, problems);
  const store = new RowStore(problems);
  const chain = chainOf(wave, byWave.get(wave) ?? [], problems);
  for (const record of chain) store.apply(record);
  applyRules(store, options.now, problems, options.revokedDevices);
  const last = chain[chain.length - 1];
  return {
    wave,
    tables: store.tables,
    head: last ? { wave, pos: last.content.pos, hash: last.hash } : null,
    problems,
    records: chain.length
  };
}
