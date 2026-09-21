import { Column, Entity, PrimaryColumn } from 'typeorm';
import { sqlExecutor } from '@/sql-executor';

// Test-only entity, deliberately absent from the application entity registry.
export const SQL_TRANSACTION_FIXTURE_TABLE = 'sql_transaction_fixture';

@Entity(SQL_TRANSACTION_FIXTURE_TABLE)
export class SqlTransactionFixtureEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 }) id!: string;
  @Column({ type: 'bigint' }) version!: string;
}

export async function createSqlTransactionFixture(): Promise<void> {
  await sqlExecutor.execute(
    `DROP TABLE IF EXISTS ${SQL_TRANSACTION_FIXTURE_TABLE}`
  );
  await sqlExecutor.execute(
    `CREATE TABLE ${SQL_TRANSACTION_FIXTURE_TABLE} (id varchar(100) PRIMARY KEY, version bigint NOT NULL)`
  );
}
