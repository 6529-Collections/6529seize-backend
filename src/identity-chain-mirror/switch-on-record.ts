import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  IDENTITY_CHAIN_PRINCIPALS_TABLE
} from '@/constants';
import { RebuildContext } from '@/rebuild/manifest.types';
import { FILE_INDEX } from '@/rebuild/sources/file-server';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { filesSourceUrl } from './placeholder-restore';
import {
  FormattedTdhOnlyRecord,
  parseTdhOnlyRecord,
  sha256Hex,
  TdhOnlyAddressKey,
  TdhOnlyIdentityRow,
  TdhOnlyRecord
} from './tdh-only-record';

/**
 * The switch-on record in the rebuild check: the identities rows with no
 * handle and no chain identity, and their address keys, as 6529.io holds
 * them right before the identity mirror's first run (the 6529.io team
 * takes it then, just before it sets the mirror's flag). Their profile ids
 * were issued at random before switch-on, so no rebuild derives them; and
 * the mirror adopts such a row's id for an identity on the same key
 * (profile-ids.ts). So the identity rebuilder loads the record's rows
 * first, then replays the mirror, which adopts the same ids again.
 *
 * The record's two files sit in the run's files source, named by their
 * SHA-256. A final run reads them by the pins below, once the team's take
 * is in the files source; until then, a run on the rebuild world reads the
 * record its own seed took at the same moment, by the pins the seed wrote
 * beside it, and a final run refuses that.
 */

export interface SwitchOnRecordPins {
  readonly identitiesSha256: string;
  readonly keysSha256: string;
}

/** The team's take, pinned by a later change once it is in the files source. */
export const SWITCH_ON_RECORD_PINS: SwitchOnRecordPins | null = null;

/** The seed's pins file in the run's seed files: the world's take. */
export const WORLD_RECORD_PINS_ID = 'switch-on-record-pins';

/** The rows a load writes in one statement. */
export const RECORD_LOAD_BATCH = 2_000;

const SHA256 = /^[0-9a-f]{64}$/;

function refuse(message: string): never {
  throw new Error(message);
}

/**
 * The record as 6529.io's database holds it now: the team's two read-only
 * queries (every identities row with no handle whose profile id is no
 * chain principal's, and those rows' address keys), in the record's order.
 * Both read in one REPEATABLE READ transaction, so they see one state: the
 * second read sees the snapshot of the first. The transaction only reads.
 */
export async function takeSwitchOnRecord(
  db: SqlExecutor = dbSupplier()
): Promise<TdhOnlyRecord> {
  const selected = `i.handle is null
       and not exists (select 1 from ${IDENTITY_CHAIN_PRINCIPALS_TABLE} m
                        where m.profile_id = i.profile_id)`;
  const { rows, keys } = await db.executeNativeQueriesInTransaction(
    async (conn) => ({
      rows: await db.execute<TdhOnlyIdentityRow>(
        `select i.consolidation_key, i.profile_id, i.primary_address,
                i.tdh, i.rep, i.cic, i.level_raw
           from ${IDENTITIES_TABLE} i
          where ${selected}
          order by i.consolidation_key`,
        undefined,
        { wrappedConnection: conn }
      ),
      keys: await db.execute<TdhOnlyAddressKey>(
        `select a.address, a.consolidation_key
           from ${ADDRESS_CONSOLIDATION_KEY} a
           join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key
          where ${selected}
          order by a.address`,
        undefined,
        { wrappedConnection: conn }
      )
    }),
    { isolationLevel: 'REPEATABLE READ' }
  );
  return {
    rows: rows.map((it) => ({
      consolidation_key: it.consolidation_key,
      profile_id: it.profile_id,
      primary_address: it.primary_address,
      tdh: Number(it.tdh),
      rep: Number(it.rep),
      cic: Number(it.cic),
      level_raw: Number(it.level_raw)
    })),
    keys: keys.map((it) => ({
      address: it.address,
      consolidation_key: it.consolidation_key
    }))
  };
}

function writeListed(seedFilesDir: string, id: string, text: string): void {
  fs.mkdirSync(seedFilesDir, { recursive: true });
  fs.writeFileSync(path.join(seedFilesDir, id), text, 'utf8');
  const index = path.join(seedFilesDir, FILE_INDEX);
  const listed: Record<string, string> = fs.existsSync(index)
    ? JSON.parse(fs.readFileSync(index, 'utf8'))
    : {};
  fs.writeFileSync(
    index,
    `${JSON.stringify({ ...listed, [id]: sha256Hex(text) }, null, 2)}\n`
  );
}

/**
 * Puts the world's take into the run's seed files: the two files named by
 * their SHA-256, and the pins file that names them, each listed in the
 * directory's index. In production the team's take goes into the files
 * source and its pins into SWITCH_ON_RECORD_PINS.
 */
export function writeSwitchOnRecordFixture(
  seedFilesDir: string,
  formatted: FormattedTdhOnlyRecord
): SwitchOnRecordPins {
  const pins: SwitchOnRecordPins = {
    identitiesSha256: formatted.identitiesSha256,
    keysSha256: formatted.keysSha256
  };
  writeListed(seedFilesDir, pins.identitiesSha256, formatted.identitiesTsv);
  writeListed(seedFilesDir, pins.keysSha256, formatted.keysTsv);
  writeListed(seedFilesDir, WORLD_RECORD_PINS_ID, `${JSON.stringify(pins)}\n`);
  return pins;
}

async function fetchText(
  files: string,
  id: string,
  what: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(filesSourceUrl(files, id));
  if (response.status !== 200) {
    refuse(`The files source has no ${what} ${id} (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

function pinsOf(value: unknown): SwitchOnRecordPins {
  const pins = value as Partial<SwitchOnRecordPins> | null;
  if (
    typeof pins?.identitiesSha256 !== 'string' ||
    typeof pins?.keysSha256 !== 'string' ||
    !SHA256.test(pins.identitiesSha256) ||
    !SHA256.test(pins.keysSha256)
  ) {
    refuse(
      `The switch-on record's pins file does not name two SHA-256s: ${JSON.stringify(value)}`
    );
  }
  return {
    identitiesSha256: pins.identitiesSha256,
    keysSha256: pins.keysSha256
  };
}

/**
 * The record from the run's files source: by SWITCH_ON_RECORD_PINS when
 * set; else, on a run that isn't final, by the pins the world's seed wrote.
 * Each file is checked against its pin and the whole against the format.
 */
export async function fetchSwitchOnRecord(
  ctx: RebuildContext,
  pinned: SwitchOnRecordPins | null = SWITCH_ON_RECORD_PINS,
  fetchImpl: typeof fetch = fetch
): Promise<{ record: TdhOnlyRecord; fixture: boolean }> {
  const files = ctx.sources.files;
  if (!files) {
    refuse(
      `${ctx.stepId} reads the switch-on record: run it with --source files=<dir>`
    );
  }
  if (!pinned && ctx.final) {
    refuse(
      `${ctx.stepId}: the switch-on record is not pinned yet; a final run reads the team's take, not the rebuild world's`
    );
  }
  const pins =
    pinned ??
    pinsOf(
      JSON.parse(
        await fetchText(
          files,
          WORLD_RECORD_PINS_ID,
          "switch-on record's pins file",
          fetchImpl
        )
      )
    );
  const identitiesTsv = await fetchText(
    files,
    pins.identitiesSha256,
    "switch-on record's identities file",
    fetchImpl
  );
  const keysTsv = await fetchText(
    files,
    pins.keysSha256,
    "switch-on record's address keys file",
    fetchImpl
  );
  return {
    record: parseTdhOnlyRecord(identitiesTsv, keysTsv, pins),
    fixture: !pinned
  };
}

/**
 * The record's rows back into identities and address_consolidation_keys,
 * as step B of the TDH sync and the address-only writes left them: the
 * record's columns, every other column its default (no handle, no profile
 * fields, no xTDH, basetdh_rate 0), which is what both write.
 */
export async function loadSwitchOnRecord(
  record: TdhOnlyRecord,
  db: SqlExecutor = dbSupplier()
): Promise<{ identities: number; keys: number }> {
  await db.executeNativeQueriesInTransaction(async (connection) => {
    for (let i = 0; i < record.rows.length; i += RECORD_LOAD_BATCH) {
      const params: Record<string, unknown> = {};
      const values = record.rows
        .slice(i, i + RECORD_LOAD_BATCH)
        .map((row, n) => {
          const columns = [
            row.consolidation_key,
            row.profile_id,
            row.primary_address,
            row.tdh,
            row.rep,
            row.cic,
            row.level_raw
          ].map((value, c) => {
            const name = `r${n}_${c}`;
            params[name] = value;
            return `:${name}`;
          });
          return `(${columns.join(', ')})`;
        })
        .join(', ');
      await db.execute(
        `insert into ${IDENTITIES_TABLE}
           (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
         values ${values}`,
        params,
        { wrappedConnection: connection }
      );
    }
    for (let i = 0; i < record.keys.length; i += RECORD_LOAD_BATCH) {
      const params: Record<string, unknown> = {};
      const values = record.keys
        .slice(i, i + RECORD_LOAD_BATCH)
        .map((key, n) => {
          params[`a${n}`] = key.address;
          params[`k${n}`] = key.consolidation_key;
          return `(:a${n}, :k${n})`;
        })
        .join(', ');
      await db.execute(
        `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values ${values}`,
        params,
        { wrappedConnection: connection }
      );
    }
  });
  return { identities: record.rows.length, keys: record.keys.length };
}
