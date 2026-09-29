import {
  MEME_CARD_DROP_MAPPINGS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  COMPETITION_CLAIMS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { publicCompetitionWaveSql } from '@/competitions/competition-main-stage.repository';

interface MemeCardDropMappingRow {
  readonly meme_card_id: number;
  readonly drop_id: string;
}

function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ER_DUP_ENTRY'
  );
}

/**
 * Persistence for the purpose-built Memes Main Stage mapping table.
 *
 * The table is intentionally Main-Stage-only by construction: runtime writes
 * select configured legacy Main Stage winners or native winners with explicit
 * capability and verified claim provenance. Reads repeat that
 * per-row Main Stage winner check, so an unrelated invalid mapping cannot
 * suppress valid mappings.
 */
export class MemeCardDropMappingsDb extends LazyDbAccessCompatibleService {
  private mainStageWinnerSource(): string {
    return `select drop_id from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id = :mainStageWaveId
      union select claim.drop_id from ${COMPETITION_CLAIMS_TABLE} claim
      join ${COMPETITION_ENTRIES_TABLE} entry on entry.id = claim.entry_id and entry.competition_id = claim.competition_id
        and entry.drop_id = claim.drop_id and entry.decision_id = claim.decision_id and entry.status = 'WINNER'
      join ${COMPETITION_DECISION_WINNERS_TABLE} winner on winner.entry_id = entry.id and winner.decision_id = claim.decision_id
        and winner.competition_id = claim.competition_id and winner.\`rank\` = 1
      join ${COMPETITIONS_TABLE} competition on competition.id = claim.competition_id and competition.wave_id = entry.wave_id
        and competition.storage_mode = 'NATIVE' and competition.published_at is not null
      join ${WAVES_TABLE} hub on hub.id = competition.wave_id and ${publicCompetitionWaveSql('hub')}
      join ${COMPETITION_CAPABILITIES_TABLE} cap on cap.competition_id = claim.competition_id and cap.wave_id = entry.wave_id
        and cap.capability = 'MAIN_STAGE'`;
  }

  async findMemeCardIdsByEntryIds(
    competitionId: string,
    entryIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!entryIds.length) return {};
    const rows = await this.db.execute<{
      entry_id: string;
      meme_card_id: number;
    }>(
      `select claim.entry_id, mapping.meme_card_id
       from ${COMPETITION_CLAIMS_TABLE} claim
       join ${MEME_CARD_DROP_MAPPINGS_TABLE} mapping on mapping.drop_id = claim.drop_id
       join (${this.mainStageWinnerSource()}) winner on winner.drop_id = claim.drop_id
       where claim.competition_id = :competitionId and claim.entry_id in (:entryIds)`,
      { competitionId, entryIds, mainStageWaveId: null },
      { wrappedConnection: ctx.connection }
    );
    return rows.reduce<Record<string, number>>((result, row) => {
      result[row.entry_id] = Number(row.meme_card_id);
      return result;
    }, {});
  }
  private getRequiredConnection(
    ctx: RequestContext
  ): NonNullable<RequestContext['connection']> {
    if (!ctx.connection) {
      throw new Error('Meme card mappings can only be saved in a transaction');
    }
    return ctx.connection;
  }

  private resolveConflictReason(
    dropMapping: MemeCardDropMappingRow | undefined,
    cardMapping: MemeCardDropMappingRow | undefined
  ): string {
    if (dropMapping) {
      return `already assigned to Meme card ${dropMapping.meme_card_id}`;
    }
    if (cardMapping) {
      return `already assigned to drop ${cardMapping.drop_id}`;
    }
    return 'Main Stage winner not found';
  }

  private assertExactMapping(
    rows: MemeCardDropMappingRow[],
    dropId: string,
    memeCardId: number
  ): void {
    if (
      rows.some(
        (row) =>
          row.drop_id === dropId && Number(row.meme_card_id) === memeCardId
      )
    ) {
      return;
    }
    const dropMapping = rows.find((row) => row.drop_id === dropId);
    const cardMapping = rows.find(
      (row) => Number(row.meme_card_id) === memeCardId
    );
    const reason = this.resolveConflictReason(dropMapping, cardMapping);
    throw new Error(
      `Cannot assign Meme card ${memeCardId} to drop ${dropId}: ${reason}`
    );
  }

  async findMemeCardIdsByDropIds(
    dropIds: string[],
    mainStageWaveId: string | null,
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    const timerName = `${this.constructor.name}->findMemeCardIdsByDropIds`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select mapping.drop_id, mapping.meme_card_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE} mapping
         join (${this.mainStageWinnerSource()}) winner
           on winner.drop_id = mapping.drop_id
         where mapping.drop_id in (:dropIds)
        `,
        { dropIds, mainStageWaveId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      return rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.drop_id] = Number(row.meme_card_id);
        return acc;
      }, {});
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async findByMemeCardId(
    memeCardId: number,
    mainStageWaveId: string | null,
    ctx: RequestContext
  ): Promise<MemeCardDropMappingRow | null> {
    const timerName = `${this.constructor.name}->findByMemeCardId`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select mapping.meme_card_id, mapping.drop_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE} mapping
         join (${this.mainStageWinnerSource()}) winner
           on winner.drop_id = mapping.drop_id
         where mapping.meme_card_id = :memeCardId
         limit 1`,
        { memeCardId, mainStageWaveId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      const mapping = rows[0];
      return mapping
        ? {
            meme_card_id: Number(mapping.meme_card_id),
            drop_id: mapping.drop_id
          }
        : null;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async isMainStageWinnerDrop(
    dropId: string,
    mainStageWaveId: string | null,
    ctx: RequestContext
  ): Promise<boolean> {
    const connection = this.getRequiredConnection(ctx);
    const timerName = `${this.constructor.name}->isMainStageWinnerDrop`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<{ found: number }>(
        `select 1 as found
         from (${this.mainStageWinnerSource()}) winner
         where drop_id = :dropId
         limit 1`,
        { dropId, mainStageWaveId },
        { wrappedConnection: connection }
      );
      return rows.length > 0;
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async setMemeCardIdForDrop(
    dropId: string,
    memeCardId: number,
    mainStageWaveId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    const connection = this.getRequiredConnection(ctx);
    const timerName = `${this.constructor.name}->setMemeCardIdForDrop`;
    try {
      ctx.timer?.start(timerName);
      try {
        await this.db.execute(
          `insert into ${MEME_CARD_DROP_MAPPINGS_TABLE} (meme_card_id, drop_id)
           select :memeCardId, winner.drop_id
           from (${this.mainStageWinnerSource()}) winner
           where winner.drop_id = :dropId`,
          { dropId, memeCardId, mainStageWaveId },
          { wrappedConnection: connection }
        );
      } catch (error) {
        if (!isDuplicateEntryError(error)) {
          throw error;
        }
      }
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select meme_card_id, drop_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE}
         where drop_id = :dropId or meme_card_id = :memeCardId`,
        { dropId, memeCardId },
        { wrappedConnection: connection }
      );
      this.assertExactMapping(rows, dropId, memeCardId);
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const memeCardDropMappingsDb = new MemeCardDropMappingsDb(dbSupplier);
