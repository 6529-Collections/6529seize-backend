import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import {
  DROP_VOTE_CHANGES,
  DROP_VOTES_TABLE,
  DROPS_TABLE,
  WAVES_TABLE
} from '../../../constants';
import { WaveEntity } from '../../../entities/IWave';
import { DropVoteEntity } from '../../../entities/IDropVote';
import { Time } from '../../../time';

export class DropVotingDb extends LazyDbAccessCompatibleService {
  public async findDropWave(dropId: string): Promise<WaveEntity | null> {
    return this.db.findOneOrNull<WaveEntity>(
      `select w.* from ${DROPS_TABLE} d join ${WAVES_TABLE} w on w.id = drop.wave_id where d.id = :dropId`,
      { dropId }
    );
  }

  public async lockDropVote(
    param: {
      drop_id: string;
      voter_id: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<DropVoteEntity> {
    const entity = await this.db.findOneOrNull<DropVoteEntity>(
      `select v.* from ${DROP_VOTES_TABLE} v where v.drop_id = :drop_id and v.voter_id = :voter_id for update`,
      param,
      { wrappedConnection: connection.connection }
    );
    if (entity) {
      return entity;
    }
    await this.db.execute(
      `insert into ${DROP_VOTES_TABLE} (drop_id, voter_id, vote) values (:drop_id, :voter_id, 0)`,
      param,
      { wrappedConnection: connection }
    );
    return (await this.db.findOneOrNull<DropVoteEntity>(
      `select v.* from ${DROP_VOTES_TABLE} v where v.drop_id = :drop_id and v.voter_id = :voter_id for update`,
      param,
      { wrappedConnection: connection.connection }
    ))!;
  }

  async updateDropVote(
    param: { id: string; vote: number },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${DROP_VOTES_TABLE} set vote = :vote where id = :id`,
      param,
      { wrappedConnection: connection.connection }
    );
  }

  async insertVoteChange(
    param: {
      dropId: string;
      change: number;
      voterId: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${DROP_VOTE_CHANGES} (drop_id, vote_change, rater_id, timestamp) values (:dropId, :change, :voterId, :timestamp)`,
      { ...param, timestamp: Time.currentMillis() },
      { wrappedConnection: connection.connection }
    );
  }

  async findTopVoters(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { voter_id: string; vote: number }[]>> {
    if (!dropIds.length) {
      return {};
    }
    return this.db
      .execute<{ voter_id: string; drop_id: string; vote: number }>(
        `select voter_id, drop_id, vote
          from (select voter_id, drop_id, vote, row_number() over (partition by drop_id order by abs(vote) desc) as n
                from ${DROP_VOTES_TABLE}
                where drop_id in (:dropIds) and vote <> 0) as x
          where n <= 5`,
        { dropIds },
        connection
          ? {
              wrappedConnection: connection.connection
            }
          : undefined
      )
      .then((rows) => {
        return rows.reduce((acc, row) => {
          if (!acc[row.drop_id]) {
            acc[row.drop_id] = [];
          }
          acc[row.drop_id].push({
            voter_id: row.voter_id,
            vote: row.vote
          });
          return acc;
        }, {} as Record<string, { voter_id: string; vote: number }[]>);
      });
  }

  async findDropsTotalRatingsStats(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { cnt: number; vote: number }>> {
    if (!dropIds.length) {
      return {};
    }
    return this.db
      .execute<{ drop_id: string; cnt: number; vote: number }>(
        `
    select drop_id, count(*) as cnt, sum(vote) as vote from ${DROP_VOTES_TABLE} where drop_id in (:dropIds) and vote <> 0 group by drop_id
    `,
        dropIds,
        connection
          ? {
              wrappedConnection: connection.connection
            }
          : undefined
      )
      .then((rows) => {
        return rows.reduce((acc, row) => {
          acc[row.drop_id] = {
            cnt: row.cnt,
            vote: row.vote
          };
          return acc;
        }, {} as Record<string, { cnt: number; vote: number }>);
      });
  }

  async findVotesForVoterAndDrops(
    voterId: string | undefined,
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    if (!voterId || !dropIds.length) {
      return {};
    }
    return this.db
      .execute<{
        drop_id: string;
        vote: number;
      }>(
        `select drop_id, vote from ${DROP_VOTES_TABLE} where voter_id = :voterId and drop_id in (:dropIds) and vote <> 0`,
        { voterId, dropIds },
        connection
          ? {
              wrappedConnection: connection.connection
            }
          : undefined
      )
      .then((rows) => {
        return rows.reduce((acc, row) => {
          acc[row.drop_id] = row.vote;
          return acc;
        }, {} as Record<string, number>);
      });
  }
}

export const dropVotingDb = new DropVotingDb(dbSupplier);
