import {
  MEME_CARD_DROP_MAPPINGS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

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

export class MemeCardDropMappingsDb extends LazyDbAccessCompatibleService {
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
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    const timerName = `${this.constructor.name}->findMemeCardIdsByDropIds`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select drop_id, meme_card_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE}
         where drop_id in (:dropIds)`,
        { dropIds },
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
    ctx: RequestContext
  ): Promise<MemeCardDropMappingRow | null> {
    const timerName = `${this.constructor.name}->findByMemeCardId`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select meme_card_id, drop_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE}
         where meme_card_id = :memeCardId
         limit 1`,
        { memeCardId },
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
    mainStageWaveId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const connection = this.getRequiredConnection(ctx);
    const timerName = `${this.constructor.name}->isMainStageWinnerDrop`;
    try {
      ctx.timer?.start(timerName);
      const rows = await this.db.execute<{ found: number }>(
        `select 1 as found
         from ${WAVES_DECISION_WINNER_DROPS_TABLE}
         where wave_id = :mainStageWaveId and drop_id = :dropId
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
    mainStageWaveId: string,
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
           from ${WAVES_DECISION_WINNER_DROPS_TABLE} winner
           where winner.wave_id = :mainStageWaveId
             and winner.drop_id = :dropId`,
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
