import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import { ClapCreditSpendingEntity } from '../../../entities/IClapCreditSpending';
import {
  CLAP_CREDIT_SPENDINGS_TABLE,
  DROP_CLAPPER_STATE_TABLE
} from '../../../constants';
import { Time } from '../../../time';
import { DropClapperStateEntity } from '../../../entities/IDropClapperState';

export class ClappingDb extends LazyDbAccessCompatibleService {
  public async upsertState(state: NewDropClapperState, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->upsertState`);
    await this.db.execute(
      `
      insert into ${DROP_CLAPPER_STATE_TABLE} (clapper_id, drop_id, claps, wave_id) 
      values (:clapper_id, :drop_id, :claps, :wave_id)
      on duplicate key update claps = :claps
    `,
      state,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
  }

  public async getCurrentState(
    param: { clapperId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCurrentState`);
    const claps = await this.db
      .oneOrNull<{ claps: number }>(
        `
      select claps from ${DROP_CLAPPER_STATE_TABLE}
      where clapper_id = :clapperId and drop_id = :drop_id
      for update
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.claps ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getCurrentState`);
    return claps;
  }

  public async insertCreditSpending(
    creditSpending: NewClapCreditSpending,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertCreditSpending`);
    await this.db.execute(
      `
      insert into ${CLAP_CREDIT_SPENDINGS_TABLE} (
          clapper_id, 
        drop_id, 
        credit_spent, 
        created_at, 
        wave_id
      )
      values (
        :clapper_id, 
        :drop_id, 
        :credit_spent, 
        :created_at, 
        :wave_id
      )
    `,
      creditSpending,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->insertCreditSpending`);
  }

  public async getCreditSpentInTimespan(
    {
      clapperId,
      timeSpanStart,
      timeSpanEnd
    }: { clapperId: string; timeSpanStart: Time; timeSpanEnd: Time },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCreditSpentInTimespan`);
    const result = await this.db
      .oneOrNull<{ credit_spent: number }>(
        `
      select sum(credit_spent) as credit_spent from ${CLAP_CREDIT_SPENDINGS_TABLE}
      where clapper_id = :clapperId and created_at >= :timeSpanStart and created_at <= :timeSpanEnd
    `,
        {
          clapperId,
          timeSpanStart: timeSpanStart.toMillis(),
          timeSpanEnd: timeSpanEnd.toMillis()
        },
        { wrappedConnection: ctx.connection }
      )
      .then((it) => it?.credit_spent ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getCreditSpentInTimespan`);
    return result;
  }

  public async mergeOnProfileIdChange(
    {
      previous_id,
      new_id
    }: {
      previous_id: string;
      new_id: string;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->mergeOnProfileIdChange`);
    await Promise.all([
      this.db.execute(
        `
        update ${CLAP_CREDIT_SPENDINGS_TABLE} 
        set clapper_id = :new_id
        where clapper_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `
        update ${DROP_CLAPPER_STATE_TABLE} 
        set clapper_id = :new_id
        where clapper_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      )
    ]);
    ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
  }

  public async getTallyForDrops(
    { dropIds, clapperId }: { dropIds: string[]; clapperId: string | null },
    ctx: RequestContext
  ): Promise<
    Record<string, { total_claps: number; claps_by_clapper: number }>
  > {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getTallyForDrops`);
    const sql = `
  select drop_id, sum(claps) as total_claps ${
    clapperId !== null
      ? `, sum(case when clapper_id = :clapperId then 1 else 0 end) as claps_by_clapper`
      : ` `
  } from ${DROP_CLAPPER_STATE_TABLE}
  where drop_id in (:dropIds)
  group by 1
`;
    const result = await this.db
      .execute<{
        drop_id: string;
        total_claps: number;
        claps_by_clapper: number;
      }>(sql, { dropIds, clapperId }, { wrappedConnection: ctx.connection })
      .then((it) =>
        it.reduce(
          (acc, { drop_id, total_claps, claps_by_clapper }) => ({
            ...acc,
            [drop_id]: { total_claps, claps_by_clapper: claps_by_clapper ?? 0 }
          }),
          {} as Record<
            string,
            { total_claps: number; claps_by_clapper: number }
          >
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getTallyForDrops`);
    return result;
  }

  async findDropsTopContributors(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, { claps: number; clapper_id: string }[]>> {
    if (dropIds.length === 0) {
      return {};
    }
    return await this.db
      .execute<{
        drop_id: string;
        clapper_id: string;
        claps: number;
      }>(
        `
      select drop_id, clapper_id, claps from ${DROP_CLAPPER_STATE_TABLE} where drop_id in (:dropIds) and claps <> 0
    `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => {
        return res.reduce(
          (acc, { drop_id, clapper_id, claps }) => ({
            ...acc,
            [drop_id]: [...(acc[drop_id] ?? []), { clapper_id, claps }]
          }),
          {} as Record<string, { claps: number; clapper_id: string }[]>
        );
      });
  }

  async deleteForDrop(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_CLAPPER_STATE_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendings(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${CLAP_CREDIT_SPENDINGS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_CLAPPER_STATE_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendingsForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${CLAP_CREDIT_SPENDINGS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }
}

export type NewClapCreditSpending = Omit<ClapCreditSpendingEntity, 'id'>;
export type NewDropClapperState = Omit<DropClapperStateEntity, 'id'>;

export const clappingDb = new ClappingDb(dbSupplier);
