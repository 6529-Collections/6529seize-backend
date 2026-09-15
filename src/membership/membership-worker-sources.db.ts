import { IDENTITIES_TABLE } from '@/constants';
import { LazyDbAccessCompatibleService } from '@/sql-executor';
import {
  MembershipPrimaryContext,
  membershipQueryOptions
} from './membership-primary';
import {
  MembershipSourceStatesDb,
  MembershipSourceEvidence,
  membershipSourceKeyId
} from './membership-source-states.db';
import { MembershipSourceVersion } from './membership-schema.types';
import {
  MEMBERSHIP_FANOUT_KEYS,
  MEMBERSHIP_IDENTITY_KEY
} from './membership-worker-validation';
import {
  MembershipFanoutCursorV1,
  MembershipWorkerError,
  MembershipWorkerRun
} from './membership-worker.types';
import {
  MEMBERSHIP_DB_NOW,
  timeMembershipOperation
} from './membership-repository.utils';
import {
  assertMembershipBoundedInteger,
  assertMembershipId,
  normalizeCounter
} from './membership-validation';

interface SourceOrder {
  character_set: string;
  collation: string;
}
interface FanoutIdentityRow {
  profile_id: string;
  occurrences: number | string;
}
export interface MembershipFanoutPage {
  ids: string[];
  after_id: string | null;
  done: boolean;
}

export class MembershipWorkerSourcesDb extends LazyDbAccessCompatibleService {
  async fanoutSeed(ctx: MembershipPrimaryContext): Promise<{
    source_versions: MembershipSourceVersion[];
    catalog_version: string;
    evaluation_time_millis: string;
    through_id: string | null;
    traversal_collation: string;
  }> {
    return timeMembershipOperation(
      'MembershipWorkerSourcesDb->fanoutSeed',
      ctx,
      async () => {
        const evidence = await new MembershipSourceStatesDb(() => this.db).read(
          MEMBERSHIP_FANOUT_KEYS,
          false,
          ctx
        );
        const source_versions = evidence.map((entry) =>
          this.fanoutEvidence(entry)
        );
        const order = await this.identityOrder(ctx);
        const rows = await this.db.execute<FanoutIdentityRow>(
          `SELECT p.profile_id,COUNT(*) OVER(PARTITION BY p.profile_id) occurrences FROM
          (SELECT i.profile_id FROM ${IDENTITIES_TABLE} i FORCE INDEX(identity_profile_id_idx)
           WHERE i.profile_id IS NOT NULL ORDER BY i.profile_id DESC LIMIT 2) p ORDER BY p.profile_id DESC`,
          {},
          membershipQueryOptions(ctx)
        );
        this.validateIdentityRows(rows);
        const now = await this.db.oneOrNull<{ now: string }>(
          `SELECT CAST(${MEMBERSHIP_DB_NOW} AS CHAR) now`,
          {},
          membershipQueryOptions(ctx)
        );
        return {
          source_versions,
          catalog_version: source_versions.find(
            (key) => key.dimension === 'GROUP_CATALOG'
          )!.version,
          evaluation_time_millis: normalizeCounter(now?.now),
          through_id: rows[0]?.profile_id ?? null,
          traversal_collation: order.collation
        };
      }
    );
  }

  private fanoutEvidence({
    key,
    state,
    provisioned
  }: MembershipSourceEvidence): MembershipSourceVersion {
    if (
      !state ||
      !provisioned ||
      (key.dimension === 'IDENTITY' && state.active_jobs !== 0)
    )
      throw new MembershipWorkerError(
        'SOURCE_NOT_READY',
        'Membership fanout source is not provisioned and idle'
      );
    return { ...key, version: state.version };
  }

  async validateSources(
    run: MembershipWorkerRun,
    lock: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    return timeMembershipOperation(
      'MembershipWorkerSourcesDb->validateSources',
      ctx,
      async () => {
        const fanout = run.scope !== 'PROFILE';
        // Fanout completion locks only IDENTITY. Catalogue is audit, never authority.
        const keys =
          lock && fanout ? [MEMBERSHIP_IDENTITY_KEY] : run.source_versions;
        const evidence = await new MembershipSourceStatesDb(() => this.db).read(
          keys,
          lock,
          ctx
        );
        const captured = new Map(
          run.source_versions.map((entry) => [
            membershipSourceKeyId(entry),
            entry.version
          ])
        );
        for (const { key, state, provisioned } of evidence) {
          if (!state || !provisioned)
            throw new MembershipWorkerError(
              'SOURCE_NOT_READY',
              'Membership source evidence is missing'
            );
          if (
            state.active_jobs !== 0 &&
            (!fanout || key.dimension === 'IDENTITY')
          )
            throw new MembershipWorkerError(
              'SOURCE_NOT_READY',
              'Membership source has an active barrier'
            );
          const version = captured.get(membershipSourceKeyId(key));
          if (version === undefined || BigInt(state.version) < BigInt(version))
            throw new MembershipWorkerError(
              'INTEGRITY',
              'Membership source version regressed'
            );
          if (
            !fanout &&
            key.dimension !== 'GROUP_CATALOG' &&
            version !== state.version
          )
            throw new MembershipWorkerError(
              'SOURCE_CHANGED',
              'Membership profile source changed'
            );
        }
      }
    );
  }

  async identityOrder(ctx: MembershipPrimaryContext): Promise<SourceOrder> {
    const row = await this.db.oneOrNull<SourceOrder>(
      `SELECT CHARACTER_SET_NAME character_set,COLLATION_NAME collation FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=:table AND column_name='profile_id'`,
      { table: IDENTITIES_TABLE },
      membershipQueryOptions(ctx)
    );
    if (
      !row ||
      !/^utf8(mb3|mb4)?$/.test(row.character_set) ||
      !/^utf8(mb3|mb4)?_[a-z0-9_]+$/.test(row.collation)
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Unsupported membership identity collation'
      );
    return row;
  }

  async fanoutPage(
    run: MembershipWorkerRun,
    size: number,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipFanoutPage> {
    return timeMembershipOperation(
      'MembershipWorkerSourcesDb->fanoutPage',
      ctx,
      async () => {
        assertMembershipBoundedInteger(size, 'fanout page size', 1, 128);
        const cursor = run.progress_cursor;
        if (cursor.kind !== 'PROFILE_FANOUT' || cursor.phase !== 'SCAN')
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Invalid fanout scan state'
          );
        const order = await this.identityOrder(ctx);
        if (order.collation !== cursor.traversal_collation)
          throw new MembershipWorkerError(
            'INTEGRITY',
            'Identity traversal collation changed'
          );
        await this.validateFanoutFrontier(cursor, order, ctx);
        if (cursor.through_id === null)
          return { ids: [], after_id: null, done: true };
        // The inner LIMIT bounds window work. Partitioning by the source column
        // detects aliases under its collation as well as byte-identical IDs.
        const rows = await this.db.execute<FanoutIdentityRow>(
          `SELECT p.profile_id,COUNT(*) OVER(PARTITION BY p.profile_id) occurrences FROM
          (SELECT i.profile_id FROM ${IDENTITIES_TABLE} i FORCE INDEX(identity_profile_id_idx)
        WHERE i.profile_id IS NOT NULL ${cursor.after_id === null ? '' : 'AND i.profile_id>:after'} AND i.profile_id<=:through
        ORDER BY i.profile_id LIMIT :limit) p ORDER BY p.profile_id`,
          {
            after: cursor.after_id,
            through: cursor.through_id,
            limit: size + 1
          },
          membershipQueryOptions(ctx)
        );
        this.validateIdentityRows(rows);
        const ids = rows.slice(0, size).map((row) => row.profile_id);
        return {
          ids,
          after_id: ids[ids.length - 1] ?? cursor.after_id,
          done: rows.length <= size
        };
      }
    );
  }

  private validateIdentityRows(rows: readonly FanoutIdentityRow[]): void {
    for (const row of rows) {
      assertMembershipId(row.profile_id, 'canonical identity profile', 50);
      if (normalizeCounter(row.occurrences) !== '1')
        throw new MembershipWorkerError(
          'INTEGRITY',
          'A profile has multiple canonical identity rows'
        );
    }
  }

  private async validateFanoutFrontier(
    cursor: MembershipFanoutCursorV1,
    order: SourceOrder,
    ctx: MembershipPrimaryContext
  ): Promise<void> {
    if (cursor.through_id !== null)
      assertMembershipId(cursor.through_id, 'fanout high bound', 50);
    if (cursor.after_id === null) return;
    assertMembershipId(cursor.after_id, 'fanout frontier', 50);
    if (cursor.through_id === null)
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Fanout frontier exists outside an empty captured range'
      );
    const row = await this.db.oneOrNull<{ valid: number | string }>(
      `SELECT
      (CONVERT(:after USING ${order.character_set}) COLLATE ${order.collation} <=
       CONVERT(:through USING ${order.character_set}) COLLATE ${order.collation}) valid`,
      { after: cursor.after_id, through: cursor.through_id },
      membershipQueryOptions(ctx)
    );
    if (normalizeCounter(row?.valid) !== '1')
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Fanout frontier exceeds its captured high bound'
      );
  }
}
