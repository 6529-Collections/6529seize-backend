import { PERSONAL_RECORDS_STATE_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { importOrderKey, RecordOrderKey } from '@/signed-records/record-order';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const STATE_ID = 'switch';
// The API reads the switch at most this often; a freeze reaches every
// container within it.
const CACHE_MS = 5_000;

export interface PersonalSwitchState {
  // Every settings write answers 503 while frozen.
  readonly frozen: boolean;
  // The latest import's order key; records ordered at or before it are stale.
  readonly importOrder: RecordOrderKey | null;
}

interface StateRow {
  readonly frozen: number | boolean | string;
  readonly import_anchor: number | string | null;
  readonly import_at: number | string | null;
}

/**
 * The personal settings switch in the database, the one source the API
 * and the import task both read: the freeze, and the latest import.
 */
export class PersonalRecordsStateDb extends LazyDbAccessCompatibleService {
  private cached: {
    readonly state: PersonalSwitchState;
    readonly at: number;
  } | null = null;

  async read(
    opts: { readonly fresh?: boolean; readonly ctx?: RequestContext } = {}
  ): Promise<PersonalSwitchState> {
    const now = Date.now();
    if (!opts.fresh && this.cached && now - this.cached.at < CACHE_MS) {
      return this.cached.state;
    }
    const rows = await this.db.execute<StateRow>(
      `select frozen, import_anchor, import_at from ${PERSONAL_RECORDS_STATE_TABLE}
       where id = :id`,
      { id: STATE_ID },
      opts.ctx?.connection
        ? { wrappedConnection: opts.ctx.connection }
        : undefined
    );
    const row = rows[0];
    const state: PersonalSwitchState = {
      frozen:
        !!row &&
        (row.frozen === true ||
          Number(row.frozen) === 1 ||
          row.frozen === 'true'),
      importOrder:
        row && row.import_anchor !== null && row.import_at !== null
          ? importOrderKey(Number(row.import_anchor), Number(row.import_at))
          : null
    };
    this.cached = { state, at: now };
    return state;
  }

  async setFrozen(frozen: boolean): Promise<void> {
    await this.db.execute(
      `insert into ${PERSONAL_RECORDS_STATE_TABLE} (id, frozen, updated_at)
       values (:id, :frozen, :now)
       on duplicate key update frozen = :frozen, updated_at = :now`,
      { id: STATE_ID, frozen, now: Date.now() }
    );
    this.cached = null;
  }

  /**
   * A rebuild's switch state: the latest import's order key, with settings
   * open. It writes a missing row unfrozen (a rebuild starts from an empty
   * table) and leaves the freeze of an existing row as it is.
   */
  async restoreImport(
    anchor: number,
    at: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${PERSONAL_RECORDS_STATE_TABLE}
         (id, frozen, import_anchor, import_at, updated_at)
       values (:id, false, :anchor, :at, :now)
       on duplicate key update import_anchor = :anchor, import_at = :at,
         updated_at = :now`,
      { id: STATE_ID, anchor, at, now: Date.now() },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    this.cached = null;
  }

  /**
   * Records the import's order key, in the import's own transaction. The
   * import runs only while frozen, so its row exists and stays frozen.
   */
  async setImport(
    anchor: number,
    at: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.db.execute(
      `insert into ${PERSONAL_RECORDS_STATE_TABLE}
         (id, frozen, import_anchor, import_at, updated_at)
       values (:id, true, :anchor, :at, :now)
       on duplicate key update import_anchor = :anchor, import_at = :at,
         updated_at = :now`,
      { id: STATE_ID, anchor, at, now: Date.now() },
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    this.cached = null;
  }
}

export const personalRecordsStateDb = new PersonalRecordsStateDb(dbSupplier);
