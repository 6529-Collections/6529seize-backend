import { personalRecordsMode } from '@/personal-records/personal-records.mode';
import { personalRecordsStateDb } from '@/personal-records/personal-records-state.db';
import { recordLog } from '@/signed-records/record-log/record-log';
import type { ConnectionWrapper } from '@/sql-executor';
import { CollectLogBody, collectLogEntry } from './collecting-rules.log';

/** Where Collect rule changes are logged, and whether they are now. */
export interface CollectRulesJournal {
  /** Logged in primary mode, when records are the source of the rules. */
  enabled(): boolean;
  /**
   * Settings are frozen for the switch. The market's submit route isn't,
   * so a sent hash is logged then too: the import may have read its
   * binding before the hash was kept.
   */
  frozen(): Promise<boolean>;
  append(
    body: CollectLogBody,
    connection: ConnectionWrapper<unknown>
  ): Promise<void>;
}

/** The record log's `collect` lane, in the change's own transaction. */
export const collectRulesJournal: CollectRulesJournal = {
  enabled: () => personalRecordsMode() === 'primary',
  frozen: async () => (await personalRecordsStateDb.read()).frozen,
  append: (body, connection) =>
    recordLog.append([collectLogEntry(body)], { connection })
};
