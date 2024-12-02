import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE
} from '../../../constants';
import { DropVoterStateEntity } from '../../../entities/IDropVoterState';
import { DropVoteCreditSpending } from '../../../entities/IDropVoteCreditSpending';
import { Time } from '../../../time';

export class DropVotingDb extends LazyDbAccessCompatibleService {
  public async upsertState(state: NewDropVoterState, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->upsertState`);
    await this.db.execute(
      `
      insert into ${DROP_VOTER_STATE_TABLE} (voter_id, drop_id, votes, wave_id) 
      values (:voter_id, :drop_id, :votes, :wave_id)
      on duplicate key update votes = :votes
    `,
      state,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
  }

  public async upsertAggregateDropRank(
    {
      drop_id,
      change,
      wave_id
    }: { drop_id: string; change: number; wave_id: string },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->upsertAggregateDropRank`);
    await this.db.execute(
      `
      insert into ${DROP_RANK_TABLE} (drop_id, last_increased, vote, wave_id) 
      values (:drop_id, :last_increased, :change, :wave_id)
      on duplicate key update vote = vote + :change ${
        change > 0 ? `, last_increased = :last_increased` : ``
      }
    `,
      {
        drop_id,
        last_increased: change > 0 ? Time.currentMillis() : 0,
        wave_id,
        change
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->upsertAggregateDropRank`);
  }

  public async lockAggregateDropRank(dropId: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->lockAggregateDropRank`);
    await this.db.oneOrNull<{ vote: number }>(
      `select vote from ${DROP_RANK_TABLE} where drop_id = :dropId for update`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->lockAggregateDropRank`);
  }

  public async getCurrentState(
    param: { voterId: string; drop_id: string },
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->getCurrentState`);
    const votes = await this.db
      .oneOrNull<{ votes: number }>(
        `
      select votes from ${DROP_VOTER_STATE_TABLE}
      where voter_id = :voterId and drop_id = :drop_id
      for update
    `,
        param,
        { wrappedConnection: ctx.connection }
      )
      .then((result) => result?.votes ?? 0);
    ctx.timer?.stop(`${this.constructor.name}->getCurrentState`);
    return votes;
  }

  public async insertCreditSpending(
    creditSpending: NewDropVoteCreditSpending,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertCreditSpending`);
    await this.db.execute(
      `
      insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (
        voter_id, 
        drop_id, 
        credit_spent, 
        created_at, 
        wave_id
      )
      values (
        :voter_id, 
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

  public async getCreditSpentInWaves(
    { voterId, waveIds }: { voterId: string; waveIds: string[] },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (waveIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getCreditSpentInWave`);
    const result = await this.db
      .execute<{ credit_spent: number; wave_id: string }>(
        `
      select wave_id, sum(credit_spent) as credit_spent from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE}
      where voter_id = :voterId and wave_id in (:waveIds)
    `,
        {
          voterId,
          waveIds
        },
        { wrappedConnection: ctx.connection }
      )
      .then((results) =>
        results.reduce((acc, red) => {
          acc[red.wave_id] = red.credit_spent;
          return acc;
        }, {} as Record<string, number>)
      );
    ctx.timer?.stop(`${this.constructor.name}->getCreditSpentInWave`);
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
        update ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} 
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute(
        `
        update ${DROP_VOTER_STATE_TABLE} 
        set voter_id = :new_id
        where voter_id = :previous_id
      `,
        { previous_id, new_id },
        { wrappedConnection: ctx.connection }
      )
    ]);
    ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
  }

  public async getTallyForDrops(
    { dropIds }: { dropIds: string[] },
    ctx: RequestContext
  ): Promise<
    Record<string, { tally: number; total_number_of_voters: number }>
  > {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getTallyForDrops`);
    const sql = `
      select drop_id, sum(votes) as tally, count(distinct voter_id) as total_number_of_voters
      from ${DROP_VOTER_STATE_TABLE}
      where drop_id in (:dropIds)
        and votes <> 0
        group by 1
    `;
    const result = await this.db
      .execute<{
        drop_id: string;
        tally: number;
        total_number_of_voters: number;
      }>(sql, { dropIds }, { wrappedConnection: ctx.connection })
      .then((result) =>
        dropIds.reduce(
          (acc, drop_id) => ({
            ...acc,
            [drop_id]: {
              tally: result.find((it) => it.drop_id === drop_id)?.tally ?? 0,
              total_number_of_voters:
                result.find((it) => it.drop_id === drop_id)
                  ?.total_number_of_voters ?? 0
            }
          }),
          {} as Record<
            string,
            { tally: number; total_number_of_voters: number }
          >
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getTallyForDrops`);
    return result;
  }

  public async getVotersTotalVotesInWaves(
    { waveIds, voterId }: { waveIds: string[]; voterId: string },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (waveIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getVotersTotalVotesInWaves`);
    const sql = `
  select wave_id, sum(abs(votes)) as total_votes from ${DROP_VOTER_STATE_TABLE}
  where wave_id in (:waveIds) and voter_id = :voterId
  group by 1
`;
    const result = await this.db
      .execute<{
        wave_id: string;
        total_votes: number;
      }>(sql, { waveIds, voterId }, { wrappedConnection: ctx.connection })
      .then((results) =>
        waveIds.reduce(
          (acc, waveId) => ({
            ...acc,
            [waveId]:
              results.find((it) => it.wave_id === waveId)?.total_votes ?? 0
          }),
          {} as Record<string, number>
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getVotersTotalVotesInWaves`);
    return result;
  }

  public async getVotersActiveVoteForDrops(
    { dropIds, voterId }: { dropIds: string[]; voterId: string },
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (dropIds.length === 0) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getVotersActiveVoteForDrops`);
    const sql = `
  select drop_id, sum(votes) as total_votes from ${DROP_VOTER_STATE_TABLE}
  where drop_id in (:dropIds) and voter_id = :voterId
  group by 1
`;
    const result = await this.db
      .execute<{
        drop_id: string;
        total_votes: number;
      }>(sql, { dropIds, voterId }, { wrappedConnection: ctx.connection })
      .then((results) =>
        dropIds.reduce(
          (acc, drop_id) => ({
            ...acc,
            [drop_id]:
              results.find((it) => it.drop_id === drop_id)?.total_votes ?? 0
          }),
          {} as Record<string, number>
        )
      );
    ctx.timer?.stop(`${this.constructor.name}->getVotersActiveVoteForDrops`);
    return result;
  }

  public async findDropsTopContributors(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, { votes: number; voter_id: string }[]>> {
    if (dropIds.length === 0) {
      return {};
    }
    return await this.db
      .execute<{
        drop_id: string;
        voter_id: string;
        votes: number;
      }>(
        `
      with ranked_voters as (
        select 
          drop_id, 
          voter_id, 
          votes, 
          row_number() over (partition by drop_id order by votes desc) as rn
        from ${DROP_VOTER_STATE_TABLE} 
        where drop_id in (:dropIds) and votes <> 0
      )
      select 
        drop_id, 
        voter_id, 
        votes 
      from ranked_voters 
      where rn <= 5
    `,
        { dropIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => {
        return res.reduce(
          (acc, { drop_id, voter_id, votes }) => ({
            ...acc,
            [drop_id]: [...(acc[drop_id] ?? []), { voter_id, votes }]
          }),
          {} as Record<string, { votes: number; voter_id: string }[]>
        );
      });
  }

  async deleteForDrop(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_VOTER_STATE_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendings(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRanks(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_VOTER_STATE_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteCreditSpendingsForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async deleteDropRanksForWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `delete from ${DROP_RANK_TABLE} where wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  async getDropsRanks(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    if (!dropIds.length) {
      return {};
    }
    ctx.timer?.start(`${this.constructor.name}->getDropsRanks`);
    const sql = `
    SELECT drop_id, rnk
    FROM (select d.id as drop_id,
                 rank() over (partition by d.wave_id order by cast(ifnull(r.vote, 0) as unsigned) desc , cast(ifnull(r.last_increased, d.created_at) as unsigned) desc) as rnk
          from ${DROPS_TABLE} d
                   left join ${DROP_RANK_TABLE} r on r.drop_id = d.id
          where d.drop_type = 'PARTICIPATORY') drop_ranks
    WHERE drop_id in (:dropIds)
  `;
    const results = await this.db.execute<{ drop_id: string; rnk: number }>(
      sql,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->getDropsRanks`);
    return results.reduce((acc, red) => {
      acc[red.drop_id] = red.rnk;
      return acc;
    }, {} as Record<string, number>);
  }
}

export type NewDropVoteCreditSpending = Omit<DropVoteCreditSpending, 'id'>;
export type NewDropVoterState = Omit<DropVoterStateEntity, 'id'>;

export const dropVotingDb = new DropVotingDb(dbSupplier);
