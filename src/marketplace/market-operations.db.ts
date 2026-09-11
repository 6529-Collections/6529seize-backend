import { createHash, randomUUID } from 'node:crypto';
import { MarketOperationEntity } from '@/entities/IMarketOperation';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';

export type MarketOperationState =
  | 'PREPARING'
  | 'REVIEW'
  | 'APPROVAL'
  | 'AWAITING_SIGNATURE'
  | 'PUBLISHING'
  | 'LIVE'
  | 'SUBMITTED'
  | 'MINED'
  | 'CONFIRMED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'EXPIRED';
export interface MarketOperationRow extends Omit<
  MarketOperationEntity,
  'request_json' | 'prepared_json' | 'state'
> {
  request_json: unknown;
  prepared_json: unknown;
  state: MarketOperationState;
}

export function marketRequestHash(value: unknown): string {
  // Inputs are rebuilt from an allowlisted schema in a fixed property order.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class MarketOperationsDb {
  constructor(private readonly getDb: () => SqlExecutor) {}

  async create(input: {
    profileId: string;
    wallet: string;
    key: string;
    request: unknown;
    currency: string;
    ruleId?: string;
  }) {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      profile_id: input.profileId,
      rule_id: input.ruleId ?? null,
      wallet: input.wallet.toLowerCase(),
      idempotency_key: input.key,
      request_hash: marketRequestHash(input.request),
      state: 'PREPARING',
      request_json: JSON.stringify(input.request),
      currency: input.currency.toLowerCase(),
      created_at: now,
      updated_at: now,
      expires_at: now + 20000
    };
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        await this.getDb().execute(
          `INSERT INTO market_operations (id,profile_id,rule_id,wallet,idempotency_key,request_hash,state,request_json,currency,created_at,updated_at,expires_at) VALUES (:id,:profile_id,:rule_id,:wallet,:idempotency_key,:request_hash,:state,:request_json,:currency,:created_at,:updated_at,:expires_at) ON DUPLICATE KEY UPDATE id = id`,
          row,
          { wrappedConnection: connection }
        );
        const saved = await this.getDb().oneOrNull<MarketOperationRow>(
          'SELECT * FROM market_operations WHERE wallet = :wallet AND idempotency_key = :key FOR UPDATE',
          { wallet: row.wallet, key: input.key },
          { wrappedConnection: connection }
        );
        if (
          !saved ||
          saved.request_hash !== row.request_hash ||
          saved.profile_id !== input.profileId ||
          (saved.rule_id ?? null) !== (input.ruleId ?? null)
        )
          throw new CustomApiCompliantException(
            409,
            'This request key belongs to different trade terms.',
            'IDEMPOTENCY_CONFLICT'
          );
        if (saved.id === row.id)
          await this.event(saved.id, 'PREPARING', null, connection);
        return { created: saved.id === row.id, operation: saved };
      }
    );
  }

  async get(id: string, profileId: string): Promise<MarketOperationRow> {
    const row = await this.getDb().oneOrNull<MarketOperationRow>(
      'SELECT * FROM market_operations WHERE id = :id AND profile_id = :profileId',
      { id, profileId }
    );
    if (!row) throw new NotFoundException('Trade not found.');
    return row;
  }

  async getForActor(
    id: string,
    profileId: string,
    wallet: string
  ): Promise<MarketOperationRow> {
    const row = await this.getDb().oneOrNull<MarketOperationRow>(
      'SELECT * FROM market_operations WHERE id = :id AND (profile_id = :profileId OR wallet = :wallet)',
      { id, profileId, wallet: wallet.toLowerCase() }
    );
    if (!row) throw new NotFoundException('Trade not found.');
    return row;
  }

  async list(profileId: string, limit = 50) {
    return this.getDb().execute<MarketOperationRow>(
      'SELECT * FROM market_operations WHERE profile_id = :profileId ORDER BY updated_at DESC, id DESC LIMIT :limit',
      { profileId, limit }
    );
  }

  async page(
    profileId: string,
    limit: number,
    before?: { created_at: number; id: string },
    wallet?: string
  ) {
    return this.getDb().execute<MarketOperationRow>(
      `SELECT * FROM market_operations WHERE (profile_id=:profileId ${wallet ? 'OR wallet=:wallet' : ''}) ${before ? 'AND (created_at<:createdAt OR (created_at=:createdAt AND id<:id))' : ''} ORDER BY created_at DESC,id DESC LIMIT :limit`,
      {
        profileId,
        wallet: wallet?.toLowerCase(),
        limit: limit + 1,
        createdAt: before?.created_at,
        id: before?.id
      }
    );
  }

  async findOrder(wallet: string, orderHash: string) {
    return this.getDb().oneOrNull<MarketOperationRow>(
      'SELECT * FROM market_operations WHERE wallet=:wallet AND order_hash=:hash AND prepared_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1',
      { wallet: wallet.toLowerCase(), hash: orderHash.toLowerCase() }
    );
  }

  async reviewedTransaction(id: string, digest: string): Promise<unknown> {
    const row = await this.getDb().oneOrNull<{ prepared_json: unknown }>(
      'SELECT prepared_json FROM market_reviewed_transactions WHERE operation_id=:id AND transaction_digest=:digest',
      { id, digest }
    );
    return row?.prepared_json;
  }

  async transition(
    id: string,
    expected: MarketOperationState[],
    state: MarketOperationState,
    patch: {
      prepared?: unknown;
      transactionHash?: string;
      orderHash?: string;
      liabilityWei?: string;
      errorCode?: string;
      expiresAt?: number;
      fundingBalanceWei?: string;
      beforeCommit?: (connection: ConnectionWrapper<unknown>) => Promise<void>;
      reviewedTransaction?: { digest: string; prepared: unknown };
    } = {}
  ) {
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        const opts = { wrappedConnection: connection };
        const owner = await this.getDb().oneOrNull<MarketOperationRow>(
          'SELECT * FROM market_operations WHERE id = :id',
          { id },
          opts
        );
        if (!owner) throw new NotFoundException('Trade not found.');
        // Always lock wallet/currency before an operation. A locking read below
        // sees the latest committed reservations even under REPEATABLE READ.
        await this.getDb().execute(
          'INSERT INTO market_wallet_exposure_locks (wallet,currency) VALUES (:wallet,:currency) ON DUPLICATE KEY UPDATE wallet=wallet',
          { wallet: owner.wallet, currency: owner.currency },
          opts
        );
        const row = await this.getDb().oneOrNull<MarketOperationRow>(
          'SELECT * FROM market_operations WHERE id = :id FOR UPDATE',
          { id },
          opts
        );
        if (!row || !expected.includes(row.state))
          throw new CustomApiCompliantException(
            409,
            'The trade changed. Refresh before continuing.',
            'OPERATION_CHANGED'
          );
        if (
          patch.liabilityWei !== undefined &&
          BigInt(patch.liabilityWei) > BigInt(row.liability_wei)
        ) {
          await this.reserveExposure(
            row,
            patch.liabilityWei,
            patch.fundingBalanceWei,
            connection
          );
        }
        await patch.beforeCommit?.(connection);
        const values = {
          id,
          state,
          updatedAt: Date.now(),
          prepared:
            patch.prepared === undefined
              ? null
              : JSON.stringify(patch.prepared),
          transactionHash: patch.transactionHash?.toLowerCase() ?? null,
          orderHash: patch.orderHash ?? null,
          liabilityWei: patch.liabilityWei ?? null,
          errorCode: patch.errorCode ?? null,
          expiresAt: patch.expiresAt ?? null
        };
        try {
          await this.getDb().execute(
            `UPDATE market_operations SET state = :state, updated_at = :updatedAt, prepared_json = COALESCE(:prepared,prepared_json), transaction_hash = COALESCE(:transactionHash,transaction_hash), order_hash = COALESCE(:orderHash,order_hash), liability_wei = COALESCE(:liabilityWei,liability_wei), error_code = :errorCode, expires_at = COALESCE(:expiresAt,expires_at) WHERE id = :id`,
            values,
            opts
          );
        } catch (error) {
          if (
            patch.transactionHash &&
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ER_DUP_ENTRY'
          ) {
            throw new CustomApiCompliantException(
              409,
              'This transaction already belongs to another trade.',
              'TRANSACTION_ALREADY_CLAIMED'
            );
          }
          throw error;
        }
        if (patch.reviewedTransaction)
          await this.getDb().execute(
            'INSERT IGNORE INTO market_reviewed_transactions (operation_id,transaction_digest,prepared_json,created_at) VALUES (:id,:digest,:prepared,:now)',
            {
              id,
              digest: patch.reviewedTransaction.digest,
              prepared: JSON.stringify(patch.reviewedTransaction.prepared),
              now: Date.now()
            },
            opts
          );
        await this.event(id, state, patch.errorCode ?? null, connection);
      }
    );
  }

  private async reserveExposure(
    row: MarketOperationRow,
    liability: string,
    balance: string | undefined,
    connection: ConnectionWrapper<unknown>
  ) {
    if (balance === undefined)
      throw new CustomApiCompliantException(
        409,
        'Refresh the funding balance before preparing another offer.',
        'FUNDING_CHECK_REQUIRED'
      );
    const others = await this.getDb().execute<{ liability_wei: string }>(
      'SELECT liability_wei FROM market_operations WHERE wallet=:wallet AND currency=:currency AND id<>:id FOR UPDATE',
      { wallet: row.wallet, currency: row.currency, id: row.id },
      { wrappedConnection: connection }
    );
    const reserved = others.reduce(
      (sum, item) => sum + BigInt(item.liability_wei),
      BigInt(0)
    );
    if (reserved + BigInt(liability) > BigInt(balance))
      throw new CustomApiCompliantException(
        409,
        'Your WETH is already committed to other potential offers. Review or cancel them before preparing another.',
        'OFFER_EXPOSURE_EXCEEDED'
      );
  }

  private async event(
    id: string,
    state: MarketOperationState,
    reason: string | null,
    connection: ConnectionWrapper<unknown>
  ) {
    await this.getDb().execute(
      'INSERT INTO market_operation_events (id,operation_id,state,reason,created_at) VALUES (:eventId,:id,:state,:reason,:now)',
      { eventId: randomUUID(), id, state, reason, now: Date.now() },
      { wrappedConnection: connection }
    );
  }
}

export const marketOperationsDb = new MarketOperationsDb(dbSupplier);
