import {
  DROP_FORGE_LAUNCHES_TABLE,
  DROP_FORGE_SIGNERS_TABLE,
  DISTRIBUTION_TABLE,
  MINTING_CLAIMS_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  MINTING_MERKLE_ROOTS_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import {
  LaunchRecord,
  LaunchData,
  LaunchState,
  DistributionRow,
  LaunchSafetyError,
  LaunchRevisionConflict
} from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { NotFoundException } from '@/exceptions';

interface StoredLaunch extends Omit<LaunchRecord, 'data'> {
  data: string | LaunchData;
}
export const launchId = (chain: number, contract: string, claim: number) =>
  `${chain}:${contract.toLowerCase()}:${claim}`;
export function decodeLaunch(row: StoredLaunch): LaunchRecord {
  return {
    ...row,
    revision: Number(row.revision),
    updated_at: Number(row.updated_at),
    data:
      typeof row.data === 'string'
        ? (JSON.parse(row.data) as LaunchData)
        : row.data
  };
}

export class DropForgeRepository {
  async putDraft(
    id: string,
    revision: number,
    data: LaunchData,
    ctx: RequestContext
  ): Promise<LaunchRecord> {
    const timer = 'DropForgeRepository->putDraft';
    ctx.timer?.start(timer);
    try {
      return await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const txCtx = { ...ctx, connection };
          const rows = await sqlExecutor.execute<StoredLaunch>(
            `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE id = :id FOR UPDATE`,
            { id },
            { wrappedConnection: connection }
          );
          const existing = rows[0] ? decodeLaunch(rows[0]) : null;
          if ((existing?.revision ?? 0) !== revision)
            throw new LaunchRevisionConflict(
              'Launch revision changed; reload before editing'
            );
          if (existing && existing.state !== 'DRAFT')
            throw new LaunchSafetyError(
              'Only a draft launch can be edited; signed and completed ledgers cannot be reset'
            );
          const record: LaunchRecord = {
            id,
            revision,
            state: 'DRAFT',
            error: null,
            data,
            updated_at: Date.now()
          };
          await this.save(record, txCtx);
          return record;
        }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async find(id: string, ctx: RequestContext): Promise<LaunchRecord | null> {
    const timer = 'DropForgeRepository->find';
    ctx.timer?.start(timer);
    try {
      const row = await sqlExecutor.oneOrNull<StoredLaunch>(
        `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE id = :id`,
        { id },
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return row ? decodeLaunch(row) : null;
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async save(record: LaunchRecord, ctx: RequestContext): Promise<void> {
    const timer = 'DropForgeRepository->save';
    ctx.timer?.start(timer);
    try {
      record.revision++;
      record.updated_at = Date.now();
      await sqlExecutor.execute(
        `INSERT INTO ${DROP_FORGE_LAUNCHES_TABLE} (id, revision, state, error, data, updated_at, report_pending) VALUES (:id, :revision, :state, :error, :data, :updated_at, :report_pending) ON DUPLICATE KEY UPDATE revision = VALUES(revision), state = VALUES(state), error = VALUES(error), data = VALUES(data), updated_at = VALUES(updated_at), report_pending = VALUES(report_pending)`,
        {
          ...record,
          data: JSON.stringify(record.data),
          report_pending: record.data.events.some((event) => !event.drop_id)
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async change<T>(
    id: string,
    fn: (launch: LaunchRecord, ctx: RequestContext) => Promise<T>,
    parentCtx: RequestContext
  ): Promise<T> {
    if (!parentCtx.connection)
      return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        this.change(id, fn, { ...parentCtx, connection })
      );
    const timer = 'DropForgeRepository->change';
    parentCtx.timer?.start(timer);
    try {
      const connection = parentCtx.connection;
      const ctx = parentCtx;
      const row = await sqlExecutor.oneOrNull<StoredLaunch>(
        `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE id = :id FOR UPDATE`,
        { id },
        { wrappedConnection: connection }
      );
      if (!row) throw new NotFoundException('Launch not found');
      const record = decodeLaunch(row);
      const result = await fn(record, ctx);
      record.updated_at = Date.now();
      await this.save(record, ctx);
      return result;
    } finally {
      parentCtx.timer?.stop(timer);
    }
  }
  async active(ctx: RequestContext): Promise<LaunchRecord[]> {
    const timer = 'DropForgeRepository->active';
    ctx.timer?.start(timer);
    try {
      const rows = await sqlExecutor.execute<StoredLaunch>(
        `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE state IN ('ARMED','RUNNING') ORDER BY updated_at ASC LIMIT 20`,
        {},
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return rows.map(decodeLaunch);
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async reporting(ctx: RequestContext): Promise<LaunchRecord[]> {
    const timer = 'DropForgeRepository->reporting';
    ctx.timer?.start(timer);
    try {
      const rows = await sqlExecutor.execute<StoredLaunch>(
        `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE report_pending = 1 ORDER BY updated_at ASC LIMIT 20`,
        {},
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return rows.map(decodeLaunch);
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async wallet<T>(
    id: string,
    fn: (
      pending: { launch_id: string | null; action_id: string | null },
      ctx: RequestContext
    ) => Promise<T>,
    parentCtx: RequestContext
  ): Promise<T> {
    const timer = 'DropForgeRepository->wallet';
    parentCtx.timer?.start(timer);
    try {
      return await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { ...parentCtx, connection };
          await sqlExecutor.execute(
            `INSERT IGNORE INTO ${DROP_FORGE_SIGNERS_TABLE} (id) VALUES (:id)`,
            { id },
            { wrappedConnection: connection }
          );
          const row = await sqlExecutor.oneOrNull<{
            launch_id: string | null;
            action_id: string | null;
          }>(
            `SELECT launch_id, action_id FROM ${DROP_FORGE_SIGNERS_TABLE} WHERE id = :id FOR UPDATE`,
            { id },
            { wrappedConnection: connection }
          );
          if (!row) throw new Error('Signer coordination row missing');
          const result = await fn(row, ctx);
          await sqlExecutor.execute(
            `UPDATE ${DROP_FORGE_SIGNERS_TABLE} SET launch_id = :launch_id, action_id = :action_id WHERE id = :id`,
            { id, ...row },
            { wrappedConnection: connection }
          );
          return result;
        }
      );
    } finally {
      parentCtx.timer?.stop(timer);
    }
  }
  async lockLaunch(id: string, ctx: RequestContext): Promise<LaunchRecord> {
    const timer = 'DropForgeRepository->lockLaunch';
    ctx.timer?.start(timer);
    try {
      const row = await sqlExecutor.oneOrNull<StoredLaunch>(
        `SELECT * FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE id = :id FOR UPDATE`,
        { id },
        { wrappedConnection: ctx.connection }
      );
      if (!row) throw new NotFoundException('Launch not found');
      return decodeLaunch(row);
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async assertPrepared(data: LaunchData, ctx: RequestContext): Promise<void> {
    const timer = 'DropForgeRepository->assertPrepared';
    ctx.timer?.start(timer);
    try {
      const parameters = {
        contract: data.contract.toLowerCase(),
        claim: data.claim_id
      };
      const normalized = await sqlExecutor.execute<{
        phases: string | string[];
      }>(
        `SELECT phases FROM ${DISTRIBUTION_NORMALIZED_TABLE} WHERE contract = :contract AND card_id = :claim`,
        parameters,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      const names = new Set(
        normalized.flatMap((row) =>
          typeof row.phases === 'string'
            ? (JSON.parse(row.phases) as string[])
            : row.phases
        )
      );
      if (
        !normalized.length ||
        data.phases.some(
          (phase) =>
            phase.root !== '0x' + '0'.repeat(64) && !names.has(phase.name)
        )
      )
        throw new LaunchSafetyError(
          'Finalize the prepared distribution before arming'
        );
      const roots = await sqlExecutor.execute<{
        phase: string;
        merkle_root: string;
      }>(
        `SELECT phase, merkle_root FROM ${MINTING_MERKLE_ROOTS_TABLE} WHERE contract = :contract AND card_id = :claim`,
        parameters,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      for (const phase of data.phases) {
        if (
          phase.root !== '0x' + '0'.repeat(64) &&
          roots.find((row) => row.phase === phase.name)?.merkle_root !==
            phase.root
        )
          throw new LaunchSafetyError(
            'Stored minting proofs do not match the prepared distribution'
          );
      }
    } finally {
      ctx.timer?.stop(timer);
    }
  }
  async source(
    contract: string,
    claim: number,
    ctx: RequestContext
  ): Promise<{ metadata: string; edition: number; rows: DistributionRow[] }> {
    const timer = 'DropForgeRepository->source';
    ctx.timer?.start(timer);
    try {
      const parameters = { contract: contract.toLowerCase(), claim };
      const metadata = await sqlExecutor.oneOrNull<{
        metadata_location: string;
        edition_size: number;
      }>(
        `SELECT metadata_location, edition_size FROM ${MINTING_CLAIMS_TABLE} WHERE contract = :contract AND claim_id = :claim`,
        parameters,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      if (!metadata?.metadata_location || !metadata.edition_size)
        throw new NotFoundException(
          'Published claim metadata and edition size are required'
        );
      const rows = await sqlExecutor.execute<DistributionRow>(
        `SELECT phase, wallet, count, count_airdrop, count_allowlist FROM ${DISTRIBUTION_TABLE} WHERE contract = :contract AND card_id = :claim ORDER BY phase, wallet`,
        parameters,
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return {
        metadata: metadata.metadata_location,
        edition: Number(metadata.edition_size),
        rows
      };
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
export const dropForgeRepository = new DropForgeRepository();
export function addLaunchEvent(
  record: LaunchRecord,
  content: string,
  error = false
): void {
  record.data.events.push({
    id: `${record.id}:${record.data.events.length}`,
    content,
    error,
    at: Date.now()
  });
}
export function setLaunchState(
  record: LaunchRecord,
  state: LaunchState,
  message: string
): void {
  if (record.state === state && record.error === message) return;
  record.state = state;
  record.error = state === 'BLOCKED' ? message : null;
  addLaunchEvent(record, message, state === 'BLOCKED');
}
