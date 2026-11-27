import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PLACEHOLDERS_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { RebuildContext } from '@/rebuild/manifest.types';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { consolidationKeyOf } from './identity-plan';
import {
  PLACEHOLDERS_FORMAT,
  PlaceholderAtFreezeLine,
  PlaceholderIdentity,
  PlaceholdersAtFreezeHeader
} from './placeholders-at-freeze.format';

/**
 * The identity rebuild's placeholder profiles, from the "placeholders at
 * freeze" file (placeholders-at-freeze.format.ts): every placeholder
 * profile (handle `id-<wallet>`) as stored at the identity freeze, with its
 * identities row and that row's wallets. From the freeze nothing makes or
 * changes a placeholder, and until switch-on nothing takes one, so the
 * file holds the set the mirror lists at its first run.
 *
 * The rebuild reads it twice:
 * - before the mirror runs, as the placeholder list the mirror's first run
 *   writes (identity_chain_placeholders), so the founder rule gives an
 *   identity made on the chain the same profile id;
 * - after the mirror has caught up, to restore each placeholder no chain
 *   identity took (no mapping in identity_chain_principals): its profiles
 *   row, and its identities and address_consolidation_keys rows without
 *   the wallets bound on the chain, as the mirror's re-keying of another
 *   identity's rows leaves them (rekeyOtherRows in identity-plan.ts). The
 *   TDH columns are left to the TDH loop: a restored row starts at 0 there,
 *   as a row the mirror makes does.
 */

/**
 * The freeze's placeholders file, pinned by its SHA-256 once the freeze
 * writes it; the file then goes into the files directory the run is given,
 * named by its SHA-256 (the files source's ids carry no dots). Until then
 * null, and the identity steps read the rebuild world's fixture, which the
 * world's code builds (rebuild-world/fixture-file.ts).
 */
export const FREEZE_PLACEHOLDERS_SHA256: string | null = null;

/** The placeholders file a step reads, and whether it is the fixture. */
export interface PlaceholdersFileRef {
  readonly sha256: string;
  readonly fixture: boolean;
}

/** Lines read and restored at a time. */
export const PLACEHOLDER_BATCH = 2_000;

/** The file can't be used as it is: nothing of it is restored. */
export class PlaceholdersFileRefused extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PlaceholdersFileRefused';
  }
}

/**
 * The database can't take the restore as it is (a placeholder's profile id
 * some profiles row already holds): nothing of the batch is restored.
 */
export class PlaceholderRestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'PlaceholderRestoreRefused';
  }
}

const WALLET = /^0x[0-9a-fA-F]{40}$/;

function refuse(message: string): never {
  throw new PlaceholdersFileRefused(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(o: Record<string, unknown>, field: string, where: string) {
  const value = o[field];
  if (typeof value !== 'string' || !value.length) {
    refuse(`${where}: ${field} is not a string`);
  }
  return value;
}

function textOrNull(
  o: Record<string, unknown>,
  field: string,
  where: string
): string | null {
  const value = o[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    refuse(`${where}: ${field} is neither a string nor null`);
  }
  return value;
}

function integer(o: Record<string, unknown>, field: string, where: string) {
  const value = o[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    refuse(`${where}: ${field} is not an integer`);
  }
  return value;
}

function headerOf(raw: unknown): PlaceholdersAtFreezeHeader {
  if (!isRecord(raw) || raw.format !== PLACEHOLDERS_FORMAT) {
    refuse(`The first line is not a ${PLACEHOLDERS_FORMAT} header`);
  }
  const where = 'The header';
  const tdhBlock = raw.tdh_block;
  if (
    tdhBlock !== null &&
    (typeof tdhBlock !== 'number' || !Number.isSafeInteger(tdhBlock))
  ) {
    refuse(`${where}: tdh_block is neither an integer nor null`);
  }
  const count = integer(raw, 'count', where);
  if (count < 0) refuse(`${where}: count is ${count}`);
  return {
    format: PLACEHOLDERS_FORMAT,
    freeze_ms: integer(raw, 'freeze_ms', where),
    tdh_block: tdhBlock,
    exporter_revision: text(raw, 'exporter_revision', where),
    count
  };
}

function identityOf(raw: unknown, where: string): PlaceholderIdentity | null {
  if (raw === null) return null;
  if (!isRecord(raw)) refuse(`${where}: identity is neither a row nor null`);
  const at = `${where}'s identity`;
  const wallets = raw.wallets;
  if (
    !Array.isArray(wallets) ||
    !wallets.length ||
    wallets.some((it) => typeof it !== 'string' || !WALLET.test(it))
  ) {
    refuse(`${at}: wallets is not a list of wallets`);
  }
  return {
    consolidation_key: text(raw, 'consolidation_key', at),
    primary_address: text(raw, 'primary_address', at),
    handle: textOrNull(raw, 'handle', at),
    normalised_handle: textOrNull(raw, 'normalised_handle', at),
    pfp: textOrNull(raw, 'pfp', at),
    banner1: textOrNull(raw, 'banner1', at),
    banner2: textOrNull(raw, 'banner2', at),
    classification: textOrNull(raw, 'classification', at),
    sub_classification: textOrNull(raw, 'sub_classification', at),
    rep: integer(raw, 'rep', at),
    cic: integer(raw, 'cic', at),
    wallets: wallets as string[]
  };
}

/**
 * One line, checked: a placeholder profile (normalised handle `id-` and
 * its wallet, lowercased, as the mirror lists them) with every field the
 * format gives. Anything else refuses the file.
 */
export function placeholderLineOf(
  raw: unknown,
  lineNumber: number
): PlaceholderAtFreezeLine {
  const where = `Line ${lineNumber}`;
  if (!isRecord(raw)) refuse(`${where} is not a placeholder`);
  const wallet = text(raw, 'wallet', where);
  if (!WALLET.test(wallet)) refuse(`${where}: wallet is not a wallet`);
  const handle = text(raw, 'handle', where);
  const normalised = text(raw, 'normalised_handle', where);
  if (
    normalised !== `id-${wallet.toLowerCase()}` ||
    handle.toLowerCase() !== normalised
  ) {
    refuse(
      `${where}: ${normalised} is not the placeholder handle of ${wallet}`
    );
  }
  const updatedAt = raw.updated_at_ms;
  if (
    updatedAt !== null &&
    (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt))
  ) {
    refuse(`${where}: updated_at_ms is neither an integer nor null`);
  }
  return {
    profile_id: text(raw, 'profile_id', where),
    wallet,
    handle,
    normalised_handle: normalised,
    created_at_ms: integer(raw, 'created_at_ms', where),
    created_by_wallet: text(raw, 'created_by_wallet', where),
    updated_at_ms: updatedAt,
    updated_by_wallet: textOrNull(raw, 'updated_by_wallet', where),
    pfp_url: textOrNull(raw, 'pfp_url', where),
    banner_1: textOrNull(raw, 'banner_1', where),
    banner_2: textOrNull(raw, 'banner_2', where),
    website: textOrNull(raw, 'website', where),
    classification: textOrNull(raw, 'classification', where),
    sub_classification: textOrNull(raw, 'sub_classification', where),
    identity: identityOf(raw.identity, where)
  };
}

function parse(line: string, where: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return refuse(`${where} is not JSON`);
  }
}

/**
 * Reads the file's bytes (gzipped NDJSON) a batch of lines at a time,
 * checking all of it: the SHA-256, the header, every line, the order by
 * profile id (rising strictly, as the writer checks it, so no profile
 * twice), no wallet twice, and the header's count. A file that fails any
 * check is refused, at the line that fails; batches before it were handed
 * on, so a caller writes inside the step, which fails with it. Returns the
 * header.
 */
export async function readPlaceholdersFile(
  bytes: Buffer,
  expectedSha256: string,
  onBatch: (lines: PlaceholderAtFreezeLine[]) => Promise<void>,
  batchSize = PLACEHOLDER_BATCH
): Promise<PlaceholdersAtFreezeHeader> {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    refuse(
      `The placeholders file's SHA-256 is ${actual}, not ${expectedSha256}`
    );
  }
  const input = Readable.from([bytes]).pipe(createGunzip());
  const reader = createInterface({ input, crlfDelay: Infinity });
  let header: PlaceholdersAtFreezeHeader | null = null;
  let lineNumber = 0;
  let previous: string | null = null;
  const wallets = new Set<string>();
  let batch: PlaceholderAtFreezeLine[] = [];
  let lines = 0;
  for await (const text of reader) {
    lineNumber++;
    const where = `Line ${lineNumber}`;
    if (!header) {
      header = headerOf(parse(text, where));
      continue;
    }
    const line = placeholderLineOf(parse(text, where), lineNumber);
    const id = line.profile_id;
    // As the writer checks it (placeholders-at-freeze.ts).
    if (previous !== null && !(previous < id)) {
      refuse(
        `${where}: profile ${line.profile_id} is not after the line before it (sorted by profile id, each once)`
      );
    }
    previous = id;
    const wallet = line.wallet.toLowerCase();
    if (wallets.has(wallet)) refuse(`${where}: wallet ${wallet} again`);
    wallets.add(wallet);
    lines++;
    batch.push(line);
    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  }
  if (!header) refuse('The placeholders file is empty');
  if (lines !== header.count) {
    refuse(
      `The header counts ${header.count} placeholders; the file has ${lines}`
    );
  }
  if (batch.length) await onBatch(batch);
  return header;
}

/** A file id of the files source (src/rebuild/sources/file-server.ts). */
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The URL of one file of the run's files source: its base, an http(s) URL
 * with no query or fragment, then the file's id, so a request stays under
 * the source's path.
 */
export function filesSourceUrl(base: string, id: string): string {
  const url = new URL(base);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    /[?#]/.test(base)
  ) {
    throw new Error(
      `The files source is not an http(s) URL without a query: ${base}`
    );
  }
  if (!FILE_ID.test(id)) throw new Error(`Not a file id: ${id}`);
  // The parsed path, its dot segments resolved, not the base as written.
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${id}`;
  return url.toString();
}

/** The placeholders file's bytes from the run's files source. */
export async function fetchPlaceholdersFile(
  ctx: RebuildContext,
  file: PlaceholdersFileRef,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  if (file.fixture && ctx.final) {
    refuse(
      `${ctx.stepId}: the placeholders file is the rebuild world's fixture, not the freeze's; a final run takes the freeze's file`
    );
  }
  const files = ctx.sources.files;
  if (!files) {
    refuse(
      `${ctx.stepId} reads the placeholders at freeze file: run it with --source files=<dir>`
    );
  }
  const response = await fetchImpl(filesSourceUrl(files, file.sha256));
  if (response.status !== 200) {
    refuse(
      `The files source has no placeholders file ${file.sha256} (${response.status})`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

type Conn = ConnectionWrapper<any>;

function valuesOf<T>(
  rows: readonly T[],
  prefix: string,
  columns: (row: T, p: (value: unknown) => string) => string[],
  params: Record<string, unknown>
): string {
  return rows
    .map((row, i) => {
      let n = 0;
      const p = (value: unknown) => {
        const name = `${prefix}${i}_${n++}`;
        params[name] = value;
        return `:${name}`;
      };
      return `(${columns(row, p).join(', ')})`;
    })
    .join(', ');
}

/**
 * The lines into identity_chain_placeholders, as the mirror's first run
 * lists 6529.io's placeholder profiles (listPlaceholderProfiles: the
 * wallet lowercased, the profile id as stored; one already listed stays).
 */
export async function writePlaceholderList(
  lines: readonly PlaceholderAtFreezeLine[],
  db: SqlExecutor = dbSupplier()
): Promise<void> {
  if (!lines.length) return;
  const params: Record<string, unknown> = {};
  const values = valuesOf(
    lines,
    'l',
    (line, p) => [p(line.wallet.toLowerCase()), p(line.profile_id)],
    params
  );
  await db.execute(
    `insert ignore into ${IDENTITY_CHAIN_PLACEHOLDERS_TABLE} (wallet, profile_id) values ${values}`,
    params
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((it) => it.toLowerCase()))).sort(
    (a, b) => (a < b ? -1 : Number(a > b))
  );
}

/** What a placeholder no chain identity took comes back as. */
export interface RestoredIdentity {
  readonly identity: PlaceholderIdentity;
  /** Its wallets: the address_consolidation_keys rows of its key. */
  readonly wallets: string[];
  /** Some of its wallets were bound on the chain, so its key changed. */
  readonly rekeyed: boolean;
}

/**
 * The identities row of an untaken placeholder after the mirror's run,
 * given the wallets the mirror's rows hold (`bound`, lowercased): as stored
 * when none of its wallets is bound; gone when all are (the profile stays
 * without one); else on the wallets left, lowercased, with their key and
 * the primary address kept if it is among them, as rekeyOtherRows
 * (identity-plan.ts) leaves another identity's row.
 */
export function restoredIdentityOf(
  line: PlaceholderAtFreezeLine,
  bound: ReadonlySet<string>
): RestoredIdentity | null {
  const identity = line.identity;
  if (!identity) return null;
  const left = identity.wallets.filter((it) => !bound.has(it.toLowerCase()));
  if (left.length === identity.wallets.length) {
    return { identity, wallets: identity.wallets, rekeyed: false };
  }
  if (!left.length) return null;
  const remaining = uniqueSorted(left);
  const primary = identity.primary_address.toLowerCase();
  return {
    identity: {
      ...identity,
      consolidation_key: consolidationKeyOf(remaining),
      primary_address: remaining.includes(primary) ? primary : remaining[0],
      wallets: remaining
    },
    wallets: remaining,
    rekeyed: true
  };
}

export interface RestoreCounts {
  /** Placeholders a chain identity took (mapped): not restored. */
  taken: number;
  /** Profiles rows restored. */
  profiles: number;
  /** Identities rows restored, re-keyed ones among them. */
  identities: number;
  rekeyed: number;
  /** Untaken placeholders left without an identities row. */
  withoutIdentity: number;
}

/** A stored UTC DATETIME from Unix milliseconds, whatever the session's zone. */
const datetimeOf = (p: string) =>
  `timestampadd(microsecond, ${p} * 1000, '1970-01-01 00:00:00')`;

async function restoreBatch(
  lines: readonly PlaceholderAtFreezeLine[],
  db: SqlExecutor,
  counts: RestoreCounts
): Promise<void> {
  const taken = new Set(
    (
      await db.execute<{ profile_id: string }>(
        `select profile_id from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} where profile_id in (:ids)`,
        { ids: lines.map((it) => it.profile_id) }
      )
    ).map((it) => it.profile_id.toLowerCase())
  );
  const untaken = lines.filter((it) => !taken.has(it.profile_id.toLowerCase()));
  counts.taken += lines.length - untaken.length;
  if (!untaken.length) return;
  // profiles is keyed by its normalised handle, so a profile id some row
  // already holds under another handle would get a second row: refused.
  const held = await db.execute<{ external_id: string; handle: string | null }>(
    `select external_id, handle from ${PROFILES_TABLE} where external_id in (:ids)`,
    { ids: untaken.map((it) => it.profile_id) }
  );
  if (held.length) {
    throw new PlaceholderRestoreRefused(
      `Untaken placeholders' profile ids already have a profiles row, which a restore would duplicate: ${held
        .map((it) => `${it.external_id} (handle ${it.handle})`)
        .join(', ')}`
    );
  }
  const wallets = untaken.flatMap((it) => it.identity?.wallets ?? []);
  const bound = new Set(
    wallets.length
      ? (
          await db.execute<{ address: string }>(
            `select address from ${ADDRESS_CONSOLIDATION_KEY} where address in (:wallets)`,
            { wallets }
          )
        ).map((it) => it.address.toLowerCase())
      : []
  );
  const restored = untaken.map((line) => ({
    line,
    restored: restoredIdentityOf(line, bound)
  }));
  const identities = restored.flatMap((it) =>
    it.restored ? [{ line: it.line, ...it.restored }] : []
  );
  await db.executeNativeQueriesInTransaction(async (conn: Conn) => {
    const params: Record<string, unknown> = {};
    const profiles = valuesOf(
      untaken,
      'p',
      (it, p) => [
        p(it.profile_id),
        p(it.normalised_handle),
        p(it.handle),
        p(it.wallet),
        datetimeOf(p(it.created_at_ms)),
        p(it.created_by_wallet),
        it.updated_at_ms === null ? 'null' : datetimeOf(p(it.updated_at_ms)),
        p(it.updated_by_wallet),
        p(it.pfp_url),
        p(it.banner_1),
        p(it.banner_2),
        p(it.website),
        p(it.classification),
        p(it.sub_classification)
      ],
      params
    );
    await db.execute(
      `insert into ${PROFILES_TABLE} (external_id, normalised_handle, handle,
         primary_wallet, created_at, created_by_wallet, updated_at,
         updated_by_wallet, pfp_url, banner_1, banner_2, website,
         classification, sub_classification)
       values ${profiles}`,
      params,
      { wrappedConnection: conn }
    );
    if (!identities.length) return;
    const identityParams: Record<string, unknown> = {};
    const rows = valuesOf(
      identities,
      'i',
      ({ line, identity }, p) => [
        p(identity.consolidation_key),
        p(line.profile_id),
        p(identity.primary_address),
        p(identity.handle),
        p(identity.normalised_handle),
        '0',
        p(identity.rep),
        p(identity.cic),
        // level_raw: rep + tdh, the mirror's rule for rows off the chain
        // (fixLevelsOffTheChain), with the TDH area's tdh at 0.
        p(identity.rep),
        p(identity.pfp),
        p(identity.banner1),
        p(identity.banner2),
        p(identity.classification),
        p(identity.sub_classification)
      ],
      identityParams
    );
    await db.execute(
      `insert into ${IDENTITIES_TABLE} (consolidation_key, profile_id,
         primary_address, handle, normalised_handle, tdh, rep, cic,
         level_raw, pfp, banner1, banner2, classification, sub_classification)
       values ${rows}`,
      identityParams,
      { wrappedConnection: conn }
    );
    const keyParams: Record<string, unknown> = {};
    const keys = valuesOf(
      identities.flatMap(({ identity, wallets }) =>
        wallets.map((address) => ({ address, key: identity.consolidation_key }))
      ),
      'k',
      (it, p) => [p(it.address), p(it.key)],
      keyParams
    );
    await db.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) values ${keys}`,
      keyParams,
      { wrappedConnection: conn }
    );
  });
  counts.profiles += untaken.length;
  counts.identities += identities.length;
  counts.rekeyed += identities.filter((it) => it.rekeyed).length;
  counts.withoutIdentity += untaken.length - identities.length;
}

/**
 * Restores each placeholder of the file that no chain identity took, after
 * the mirror has caught up (see the module's comment).
 */
export async function restoreUntakenPlaceholders(
  bytes: Buffer,
  sha256: string,
  db: SqlExecutor = dbSupplier()
): Promise<RestoreCounts> {
  const counts: RestoreCounts = {
    taken: 0,
    profiles: 0,
    identities: 0,
    rekeyed: 0,
    withoutIdentity: 0
  };
  await readPlaceholdersFile(bytes, sha256, (lines) =>
    restoreBatch(lines, db, counts)
  );
  return counts;
}
