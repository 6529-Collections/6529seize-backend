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
      update ${DROP_CLAPPER_STATE_TABLE} set claps = :claps
      where clapper_id = :clapper_id and drop_id = :drop_id
      on duplicate key update claps = :claps
    `,
      state,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
  }

  public async getCurrentClaps(
    param: { clapperId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->upsertState`);
    const claps = await this.db
      .oneOrNull<{ claps: number }>(
        `
      select claps from ${DROP_CLAPPER_STATE_TABLE}
      where claps = :clapperId and drop_id = :dropId
      for update
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.claps ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
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
}

export type NewClapCreditSpending = Omit<ClapCreditSpendingEntity, 'id'>;
export type NewDropClapperState = Omit<DropClapperStateEntity, 'id'>;

export const clappingDb = new ClappingDb(dbSupplier);
