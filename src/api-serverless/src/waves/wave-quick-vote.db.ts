import {
  DROP_QUICKVOTE_SKIPS_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE
} from '@/constants';
import { DropEntity, DropType } from '@/entities/IDrop';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

export class WaveQuickVoteDb extends LazyDbAccessCompatibleService {
  private getQuickVoteOrderSql(): string {
    return `ORDER BY d.created_at DESC, d.serial_no DESC`;
  }

  private getSkippedFallbackOrderSql(): string {
    return `ORDER BY dqs.skipped_at ASC, d.created_at DESC, d.serial_no DESC`;
  }

  private getUnvotedDropsSql(): string {
    return `
      FROM ${DROPS_TABLE} d
      LEFT JOIN ${DROP_VOTER_STATE_TABLE} dvs
        ON dvs.drop_id = d.id
       AND dvs.wave_id = :wave_id
       AND dvs.voter_id = :identity_id
      WHERE d.wave_id = :wave_id
        AND d.drop_type = '${DropType.PARTICIPATORY}'
        AND IFNULL(dvs.votes, 0) = 0
    `;
  }

  private getUndiscoveredDropsSql(): string {
    return `
      FROM ${DROPS_TABLE} d
      LEFT JOIN ${DROP_VOTER_STATE_TABLE} dvs
        ON dvs.drop_id = d.id
       AND dvs.wave_id = :wave_id
       AND dvs.voter_id = :identity_id
      LEFT JOIN ${DROP_QUICKVOTE_SKIPS_TABLE} dqs
        ON dqs.drop_id = d.id
       AND dqs.wave_id = :wave_id
       AND dqs.identity_id = :identity_id
      WHERE d.wave_id = :wave_id
        AND d.drop_type = '${DropType.PARTICIPATORY}'
        AND IFNULL(dvs.votes, 0) = 0
        AND dqs.drop_id IS NULL
    `;
  }

  private getSkippedUnvotedDropsSql(): string {
    return `
      FROM ${DROPS_TABLE} d
      LEFT JOIN ${DROP_VOTER_STATE_TABLE} dvs
        ON dvs.drop_id = d.id
       AND dvs.wave_id = :wave_id
       AND dvs.voter_id = :identity_id
      INNER JOIN ${DROP_QUICKVOTE_SKIPS_TABLE} dqs
        ON dqs.drop_id = d.id
       AND dqs.wave_id = :wave_id
       AND dqs.identity_id = :identity_id
      WHERE d.wave_id = :wave_id
        AND d.drop_type = '${DropType.PARTICIPATORY}'
        AND IFNULL(dvs.votes, 0) = 0
    `;
  }

  async findNextUndiscoveredDrop(
    param: { identity_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<DropEntity | null> {
    ctx.timer?.start(`${this.constructor.name}->findNextUndiscoveredDrop`);
    try {
      return await this.db.oneOrNull<DropEntity>(
        `
          SELECT d.*
          ${this.getUndiscoveredDropsSql()}
          ${this.getQuickVoteOrderSql()}
          LIMIT 1
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findNextUndiscoveredDrop`);
    }
  }

  async findUndiscoveredDropBySkip(
    param: { identity_id: string; wave_id: string; skip: number },
    ctx: RequestContext
  ): Promise<DropEntity | null> {
    ctx.timer?.start(`${this.constructor.name}->findUndiscoveredDropBySkip`);
    try {
      return await this.db.oneOrNull<DropEntity>(
        `
          SELECT d.*
          ${this.getUndiscoveredDropsSql()}
          ${this.getQuickVoteOrderSql()}
          LIMIT 1
          OFFSET :skip
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findUndiscoveredDropBySkip`);
    }
  }

  async findSkippedUnvotedDropBySkip(
    param: { identity_id: string; wave_id: string; skip: number },
    ctx: RequestContext
  ): Promise<DropEntity | null> {
    ctx.timer?.start(`${this.constructor.name}->findSkippedUnvotedDropBySkip`);
    try {
      return await this.db.oneOrNull<DropEntity>(
        `
          SELECT d.*
          ${this.getSkippedUnvotedDropsSql()}
          ${this.getSkippedFallbackOrderSql()}
          LIMIT 1
          OFFSET :skip
        `,
        param,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findSkippedUnvotedDropBySkip`);
    }
  }

  async countUndiscoveredDrops(
    param: { identity_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countUndiscoveredDrops`);
    try {
      return await this.db
        .oneOrNull<{ cnt: number }>(
          `
          SELECT COUNT(*) as cnt
          ${this.getUndiscoveredDropsSql()}
        `,
          param,
          { wrappedConnection: ctx.connection }
        )
        .then((result) => result?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countUndiscoveredDrops`);
    }
  }

  async countUnvotedDrops(
    param: { identity_id: string; wave_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->countUnvotedDrops`);
    try {
      return await this.db
        .oneOrNull<{ cnt: number }>(
          `
            SELECT COUNT(*) as cnt
            ${this.getUnvotedDropsSql()}
          `,
          param,
          { wrappedConnection: ctx.connection }
        )
        .then((result) => result?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countUnvotedDrops`);
    }
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
