import { withoutLegacyCompetitionGetFacade } from '@/competitions/legacy-competition-get-facade';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  DROP_QUICKVOTE_SKIPS_TABLE,
  DROPS_TABLE
} from '@/constants';
import { DropEntity, DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

export type QuickVoteParams = { identity_id: string; wave_id: string };
export type QuickVoteCounts = {
  total_count: number;
  left_to_vote_in_current_round: number;
};

export class WaveQuickVoteDb extends LazyDbAccessCompatibleService {
  private getCandidatesSql(): string {
    // Filter native status before reading shared chat/history. The second branch
    // preserves the compatibility view's retained participatory orphans without
    // including winners, withdrawn/disqualified entries, or sibling competitions.
    // uq_competition_entry_drop guarantees one entry per original competition/drop;
    // uq_competition_vote_actor_entry guarantees one current allocation per voter.
    return `WITH candidates AS (
      SELECT d.id, d.created_at, d.serial_no, e.id AS entry_id, c.id AS competition_id
      FROM ${COMPETITIONS_TABLE} c
      JOIN ${COMPETITION_ENTRIES_TABLE} e
        ON e.competition_id = c.id AND e.status = 'ACTIVE'
      JOIN ${DROPS_TABLE} d ON d.id = e.drop_id AND d.wave_id = :wave_id
      WHERE c.legacy_wave_id = :wave_id AND c.wave_id = :wave_id
      UNION ALL
      SELECT d.id, d.created_at, d.serial_no, e.id AS entry_id, c.id AS competition_id
      FROM ${DROPS_TABLE} d
      LEFT JOIN ${COMPETITIONS_TABLE} c
        ON c.legacy_wave_id = :wave_id AND c.wave_id = :wave_id
      LEFT JOIN ${COMPETITION_ENTRIES_TABLE} e
        ON e.competition_id = c.id AND e.drop_id = d.id
      WHERE d.wave_id = :wave_id AND d.drop_type = '${DropType.PARTICIPATORY}'
        AND (e.status IS NULL OR e.status NOT IN ('ACTIVE', 'WINNER', 'WITHDRAWN', 'DISQUALIFIED'))
    )`;
  }

  private getUnvotedJoinsSql(): string {
    return `FROM candidates candidate
      LEFT JOIN ${COMPETITION_VOTES_TABLE} v
        ON v.competition_id = candidate.competition_id
       AND v.entry_id = candidate.entry_id
       AND v.voter_profile_id = :identity_id
      LEFT JOIN ${DROP_QUICKVOTE_SKIPS_TABLE} skips
        ON skips.identity_id = :identity_id
       AND skips.wave_id = :wave_id
       AND skips.drop_id = candidate.id`;
  }

  private async read<T>(
    method: string,
    sql: string,
    param: QuickVoteParams & { skip?: number; limit?: number },
    ctx: RequestContext
  ): Promise<T[]> {
    const timerName = `${this.constructor.name}->${method}`;
    ctx.timer?.start(timerName);
    try {
      // These are explicit native reads, including the shared physical drop body.
      // Request-level compatibility rewriting must not expand them back to views.
      return await withoutLegacyCompetitionGetFacade(() =>
        this.db.execute<T>(sql, param, { wrappedConnection: ctx.connection })
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async countDrops(
    param: QuickVoteParams,
    ctx: RequestContext
  ): Promise<QuickVoteCounts> {
    const [counts] = await this.read<QuickVoteCounts>(
      'countDrops',
      `${this.getCandidatesSql()}
       SELECT COUNT(*) AS total_count,
         COALESCE(SUM(skips.drop_id IS NULL), 0) AS left_to_vote_in_current_round
       ${this.getUnvotedJoinsSql()}
       WHERE COALESCE(v.value, 0) = 0`,
      param,
      ctx
    );
    return {
      total_count: Number(counts?.total_count ?? 0),
      left_to_vote_in_current_round: Number(
        counts?.left_to_vote_in_current_round ?? 0
      )
    };
  }

  async findDrops(
    param: QuickVoteParams & { skip: number; limit: number },
    skipped: boolean,
    ctx: RequestContext
  ): Promise<DropEntity[]> {
    // serial_no is the physical drops primary key, so timestamp ties are stable.
    const drops = await this.read<DropEntity>(
      skipped ? 'findSkippedDrops' : 'findUndiscoveredDrops',
      `${this.getCandidatesSql()}
       SELECT d.*
       ${this.getUnvotedJoinsSql()}
       JOIN ${DROPS_TABLE} d ON d.id = candidate.id
       WHERE COALESCE(v.value, 0) = 0
         AND skips.drop_id IS ${skipped ? 'NOT NULL' : 'NULL'}
       ORDER BY ${skipped ? 'skips.skipped_at ASC,' : ''}
         candidate.created_at DESC, candidate.serial_no DESC
       LIMIT :limit OFFSET :skip`,
      param,
      ctx
    );
    return drops.map((drop) => ({
      ...drop,
      drop_type: DropType.PARTICIPATORY
    }));
  }

  async findNextUndiscoveredDrop(
    param: QuickVoteParams,
    ctx: RequestContext
  ): Promise<DropEntity | null> {
    const drops = await this.findDrops(
      { ...param, skip: 0, limit: 1 },
      false,
      ctx
    );
    return drops[0] ?? null;
  }

  async insertSkip(
    param: { identity_id: string; wave_id: string; drop_id: string },
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->insertSkip`);
    try {
      await this.db.execute(
        `
          INSERT INTO ${DROP_QUICKVOTE_SKIPS_TABLE} (
            identity_id,
            wave_id,
            drop_id,
            skipped_at
          )
          VALUES (
            :identity_id,
            :wave_id,
            :drop_id,
            :skipped_at
          )
          ON DUPLICATE KEY UPDATE skipped_at = skipped_at
        `,
        {
          ...param,
          skipped_at: Time.currentMillis()
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertSkip`);
    }
  }

  async clearSkips(
    param: { identity_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->clearSkips`);
    try {
      await this.db.execute(
        `
          DELETE FROM ${DROP_QUICKVOTE_SKIPS_TABLE}
          WHERE identity_id = :identity_id
            AND wave_id = :wave_id
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->clearSkips`);
    }
  }

  async mergeOnProfileIdChange(
    param: { previous_id: string; new_id: string },
    ctx: { connection: ConnectionWrapper<any> }
  ): Promise<void> {
    if (param.previous_id === param.new_id) {
      return;
    }
    await this.db.execute(
      `
        UPDATE ${DROP_QUICKVOTE_SKIPS_TABLE} s1
        LEFT JOIN ${DROP_QUICKVOTE_SKIPS_TABLE} s2
          ON s2.identity_id = :new_id
         AND s2.wave_id = s1.wave_id
         AND s2.drop_id = s1.drop_id
        SET s1.identity_id = :new_id
        WHERE s1.identity_id = :previous_id
          AND s2.identity_id IS NULL
      `,
      param,
      { wrappedConnection: ctx.connection }
    );
    await this.db.execute(
      `
        DELETE FROM ${DROP_QUICKVOTE_SKIPS_TABLE}
        WHERE identity_id = :previous_id
      `,
      { previous_id: param.previous_id },
      { wrappedConnection: ctx.connection }
    );
  }
}

export const waveQuickVoteDb = new WaveQuickVoteDb(dbSupplier);
