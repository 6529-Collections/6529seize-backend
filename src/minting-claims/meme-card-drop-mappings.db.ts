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

export class MemeCardDropMappingsDb extends LazyDbAccessCompatibleService {
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

  async setMemeCardIdForDrop(
    dropId: string,
    memeCardId: number,
    mainStageWaveId: string,
    ctx: RequestContext
  ): Promise<void> {
    const timerName = `${this.constructor.name}->setMemeCardIdForDrop`;
    try {
      ctx.timer?.start(timerName);
      await this.db.execute(
        `insert into ${MEME_CARD_DROP_MAPPINGS_TABLE} (meme_card_id, drop_id)
         select :memeCardId, winner.drop_id
         from ${WAVES_DECISION_WINNER_DROPS_TABLE} winner
         where winner.wave_id = :mainStageWaveId
           and winner.drop_id = :dropId
         on duplicate key update
           drop_id = ${MEME_CARD_DROP_MAPPINGS_TABLE}.drop_id`,
        { dropId, memeCardId, mainStageWaveId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      const rows = await this.db.execute<MemeCardDropMappingRow>(
        `select meme_card_id, drop_id
         from ${MEME_CARD_DROP_MAPPINGS_TABLE}
         where drop_id = :dropId or meme_card_id = :memeCardId`,
        { dropId, memeCardId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
      if (
        rows.some(
          (row) =>
            row.drop_id === dropId && Number(row.meme_card_id) === memeCardId
        )
      ) {
        return;
      }
      const dropMapping = rows.find((row) => row.drop_id === dropId);
      if (dropMapping) {
        throw new Error(
          `Cannot assign Meme card ${memeCardId} to drop ${dropId}: ` +
            `already assigned to Meme card ${dropMapping.meme_card_id}`
        );
      }
      const cardMapping = rows.find(
        (row) => Number(row.meme_card_id) === memeCardId
      );
      if (cardMapping) {
        throw new Error(
          `Cannot assign Meme card ${memeCardId} to drop ${dropId}: ` +
            `already assigned to drop ${cardMapping.drop_id}`
        );
      }
      throw new Error(
        `Cannot assign Meme card ${memeCardId} to drop ${dropId}: ` +
          'Main Stage winner not found'
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const memeCardDropMappingsDb = new MemeCardDropMappingsDb(dbSupplier);
