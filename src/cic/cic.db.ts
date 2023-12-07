import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { CIC_STATEMENTS_TABLE } from '../constants';
import { CicStatement } from '../entities/ICICStatement';
import { uniqueShortId } from '../helpers';
import { DbPoolName } from '../db-query.options';

export class CicDb extends LazyDbAccessCompatibleService {
  async insertCicStatement(
    newCicStatement: Omit<CicStatement, 'id' | 'crated_at'>,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<CicStatement> {
    const id = uniqueShortId();
    await this.db.execute(
      `
          insert into ${CIC_STATEMENTS_TABLE}
          (id, profile_id, statement_group, statement_type, statement_comment, statement_value, crated_at)
          values (:id, :profile_id, :statement_group, :statement_type, :statement_comment, :statement_value, current_time)
      `,
      {
        id: id,
        ...newCicStatement
      },
      { wrappedConnection: connectionHolder.connection }
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
      { wrappedConnection: connectionHolder.connection }
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
          wrappedConnection: connectionHolder?.connection,
          forcePool: DbPoolName.WRITE
        }
      )
      ?.then((results) => results[0] ?? null);
  }

  async getCicStatementsByProfileId(
    profile_id: string
  ): Promise<CicStatement[]> {
    return this.db.execute(
      `select * from ${CIC_STATEMENTS_TABLE} where profile_id = :profile_id`,
      { profile_id: profile_id },
      { forcePool: DbPoolName.WRITE }
    );
  }
}

export const cicDb = new CicDb(dbSupplier);
