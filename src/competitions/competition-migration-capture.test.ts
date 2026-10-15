import { DROPS_TABLE, WAVES_TABLE } from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import {
  MIGRATION_SOURCE_TABLES,
  migrationCaptureHealthy,
  migrationCaptureStatement,
  migrationTriggerName
} from './competition-migration-capture';

const operations = ['INSERT', 'UPDATE', 'DELETE'] as const;
const waveColumns = ['id', 'name', 'updated_at', 'voting_period_end'];
const replyColumns = ['chat_replies_open', 'chat_replies_collapsed'];

function captureFixture() {
  const schema: { TABLE_NAME: string; COLUMN_NAME: string }[] =
    MIGRATION_SOURCE_TABLES.flatMap((table) =>
      (table === WAVES_TABLE
        ? [...waveColumns, ...replyColumns]
        : ['id', 'wave_id']
      ).map((column) => ({ TABLE_NAME: table, COLUMN_NAME: column }))
    );
  const triggers = MIGRATION_SOURCE_TABLES.flatMap((table) =>
    operations.map((operation) => ({
      TRIGGER_NAME: migrationTriggerName(table, operation),
      EVENT_OBJECT_TABLE: table,
      EVENT_MANIPULATION: operation,
      ACTION_TIMING: 'AFTER',
      ACTION_STATEMENT: migrationCaptureStatement(
        table,
        operation,
        table === WAVES_TABLE ? waveColumns : ['id', 'wave_id']
      )
    }))
  );
  const execute = jest.fn(async (sql: string) =>
    sql.includes('information_schema.TRIGGERS') ? triggers : schema
  );
  return { db: { execute } as unknown as SqlExecutor, triggers, schema };
}

describe('legacy migration capture compatibility with shared wave replies', () => {
  it.each(operations)(
    'accepts the current wave %s trigger alongside original v1 triggers',
    async (operation) => {
      const { db, triggers } = captureFixture();
      const trigger = triggers.find(
        (row) =>
          row.EVENT_OBJECT_TABLE === WAVES_TABLE &&
          row.EVENT_MANIPULATION === operation
      )!;
      trigger.ACTION_STATEMENT = migrationCaptureStatement(
        WAVES_TABLE,
        operation,
        [...waveColumns, ...replyColumns]
      );
      expect(await migrationCaptureHealthy(db, {})).toBe(true);
    }
  );

  it('keeps the compatibility exception scoped to the waves table', async () => {
    const { db, schema } = captureFixture();
    schema.push(
      ...replyColumns.map((column) => ({
        TABLE_NAME: DROPS_TABLE,
        COLUMN_NAME: column
      }))
    );
    expect(await migrationCaptureHealthy(db, {})).toBe(false);
  });

  it('accepts existing triggers after adding shared reply columns', async () => {
    const { db } = captureFixture();
    expect(await migrationCaptureHealthy(db, {})).toBe(true);
  });

  it('still rejects uncaptured columns outside the explicit reply exclusion', async () => {
    const { db, schema } = captureFixture();
    schema.push({
      TABLE_NAME: WAVES_TABLE,
      COLUMN_NAME: 'new_competition_rule'
    });
    expect(await migrationCaptureHealthy(db, {})).toBe(false);
  });

  it('still rejects missing triggers and changed ownership guards', async () => {
    const { db, triggers } = captureFixture();
    const trigger = triggers.find(
      (row) => row.EVENT_OBJECT_TABLE === WAVES_TABLE
    )!;
    const statement = trigger.ACTION_STATEMENT;
    trigger.ACTION_STATEMENT = statement.replace(
      "owner_mode = 'NATIVE'",
      "owner_mode = 'DISABLED'"
    );
    expect(await migrationCaptureHealthy(db, {})).toBe(false);
    trigger.ACTION_STATEMENT = statement;
    triggers.splice(triggers.indexOf(trigger), 1);
    expect(await migrationCaptureHealthy(db, {})).toBe(false);
  });
});
