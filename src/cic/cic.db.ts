import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { CIC_STATEMENTS_TABLE } from '@/constants';
import { CicStatement } from '../entities/ICICStatement';
import { DbPoolName } from '../db-query.options';
import { ids } from '../ids';

export class CicDb extends LazyDbAccessCompatibleService {
  async insertCicStatement(
    newCicStatement: Omit<CicStatement, 'id' | 'crated_at'>,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<CicStatement> {
    const id = ids.uniqueShortId();
    await this.db.execute(
      `
          insert into ${CIC_STATEMENTS_TABLE}
          (id, profile_id, statement_group, statement_type, statement_comment, statement_value, crated_at)
          values (:id, :profile_id, :statement_group, :statement_type, :statement_comment, :statement_value, current_time)
      `,
      {
        ...newCicStatement,
        id: id
      },
      { wrappedConnection: connectionHolder }
    );
    return (await this.getCicStatementByIdAndProfileId(
      {
        id,
        profile_id: newCicStatement.profile_id
      },
      connectionHolder
    ))!;
  }

  async deleteCicStatement(
    props: { profile_id: string; id: string },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${CIC_STATEMENTS_TABLE} where id = :id and profile_id = :profile_id`,
      props,
      { wrappedConnection: connectionHolder }
    );
  }

  async getCicStatementByIdAndProfileId(
    props: {
      profile_id: string;
      id: string;
    },
    connectionHolder?: ConnectionWrapper<any>
  ): Promise<CicStatement | null> {
    return this.db
      .execute(
        `select * from ${CIC_STATEMENTS_TABLE} where id = :id and profile_id = :profile_id`,
        props,
        {
          wrappedConnection: connectionHolder,
          forcePool: DbPoolName.WRITE
        }
      )
      ?.then((results) => results[0] ?? null);
  }

  async getCicStatementsByProfileId(
    profile_id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<CicStatement[]> {
    const opts = connection ? { wrappedConnection: connection } : {};
    return this.db.execute(
      `select * from ${CIC_STATEMENTS_TABLE} where profile_id = :profile_id`,
      { profile_id: profile_id },
      opts
    );
  }
}

export const cicDb = new CicDb(dbSupplier);
