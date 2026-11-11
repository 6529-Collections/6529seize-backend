import { DROP_CLIENT_IDS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { DropClientIdEntity } from '@/entities/IDropClientId';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

/** Raised inside the create transaction when the client id is already taken. */
export class DropClientIdTakenError extends Error {
  constructor() {
    super('client_drop_id is already used by this author');
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'DropClientIdTakenError';
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { code?: unknown }).code === 'ER_DUP_ENTRY' ||
      (error as { errno?: unknown }).errno === 1062)
  );
}

export class DropClientIdsDb extends LazyDbAccessCompatibleService {
  /**
   * Looks the id up on the writer: a retry usually arrives right after the
   * first attempt committed, before the replica has it.
   */
  async find(
    { authorId, clientDropId }: { authorId: string; clientDropId: string },
    ctx: RequestContext
  ): Promise<DropClientIdEntity | null> {
    const timer = `${this.constructor.name}->find`;
    ctx.timer?.start(timer);
    try {
      const row = await this.db.oneOrNull<DropClientIdEntity>(
        `select * from ${DROP_CLIENT_IDS_TABLE}
         where author_id = :authorId and client_drop_id = :clientDropId`,
        { authorId, clientDropId },
        ctx.connection
          ? { wrappedConnection: ctx.connection }
          : { forcePool: DbPoolName.WRITE }
      );
      return row ? { ...row, created_at: Number(row.created_at) } : null;
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  /**
   * Claims the id inside the create transaction. The primary key makes a
   * concurrent duplicate wait for this transaction and then fail, so only
   * one drop is ever created per author and id. Only that one key is locked.
   */
  async insert(entity: DropClientIdEntity, ctx: RequestContext): Promise<void> {
    if (!ctx.connection) {
      throw new Error('Claiming a client_drop_id requires a transaction');
    }
    const timer = `${this.constructor.name}->insert`;
    ctx.timer?.start(timer);
    try {
      await this.db.execute(
        `insert into ${DROP_CLIENT_IDS_TABLE}
           (author_id, client_drop_id, drop_id, wave_id, content_fingerprint, created_at)
         values
           (:author_id, :client_drop_id, :drop_id, :wave_id, :content_fingerprint, :created_at)`,
        entity,
        { wrappedConnection: ctx.connection }
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new DropClientIdTakenError();
      }
      throw error;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}

export const dropClientIdsDb = new DropClientIdsDb(dbSupplier);
