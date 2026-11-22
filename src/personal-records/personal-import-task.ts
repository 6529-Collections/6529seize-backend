import { identitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import { recordAnchorService } from '@/signed-records/record-anchor';
import { recordLog } from '@/signed-records/record-log/record-log';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import {
  isImportDone,
  PERSONAL_IMPORT_LANE,
  PersonalImportBody,
  PersonalImportBuilder,
  PersonalImportDone,
  personalExportDb
} from './personal-import';
import { checkPersonalItem } from './personal-record-checks';
import { personalRecordsStateDb } from './personal-records-state.db';
import { recordOwnerDirectory } from './record-owner-directory';

const logger = Logger.get('PERSONAL_IMPORT');

/**
 * The one-time import at the switch. Settings must be frozen in the shared
 * switch state (so the pages read one unchanging state). Today's rows are
 * read a page of owners at a time, their owners resolved in batches, and
 * appended to the record log as `personal-import` entries, then a closing
 * entry, which goes in with the import's order key in the switch state in
 * one transaction: a crashed run leaves no half import in force.
 */
export async function runPersonalImport(
  now: () => number = () => Date.now()
): Promise<{
  entries: number;
  skipped: Record<string, number>;
  anchor: number;
  at: number;
}> {
  if (!(await personalRecordsStateDb.read({ fresh: true })).frozen) {
    throw new Error('The personal import runs only while settings are frozen');
  }
  const { anchor } = await recordAnchorService.getAnchor();
  const at = now();
  const started = Date.now();
  const builder = new PersonalImportBuilder({
    anchor,
    at,
    ownersOf: async (profileIds) => {
      const identities = await identitiesDb.getIdentitiesByIds([...profileIds]);
      const wallets = identities
        .map((identity) => identity.primary_address?.toLowerCase())
        .filter((wallet): wallet is string => !!wallet);
      const byWallet = await recordOwnerDirectory.ownersAt(wallets, anchor);
      const owners = new Map<string, string>();
      for (const identity of identities) {
        const owner = byWallet.get(
          identity.primary_address?.toLowerCase() ?? ''
        );
        if (identity.profile_id && owner)
          owners.set(identity.profile_id, owner);
      }
      return owners;
    },
    check: checkPersonalItem,
    emit: (entries) =>
      recordLogDb.executeNativeQueriesInTransaction(async (connection) => {
        await recordLog.append(entries, { connection });
        const closing = entries.some(
          (entry) =>
            entry.t === 'entry' &&
            entry.lane === PERSONAL_IMPORT_LANE &&
            isImportDone(
              entry.body as unknown as PersonalImportBody | PersonalImportDone
            )
        );
        if (closing) {
          await personalRecordsStateDb.setImport(anchor, at, { connection });
        }
      })
  });
  let pages = 0;
  for await (const ids of personalExportDb.ownerPages()) {
    await builder.addPage(await personalExportDb.readPage(ids));
    pages++;
  }
  const result = await builder.finish();
  // Rows the pages never reach: their owner id has no profile.
  for (const [table, count] of Object.entries(
    await personalExportDb.countRowsWithoutProfile()
  )) {
    result.skipped[`no profile: ${table}`] = count;
  }
  logger.info(
    `[PERSONAL IMPORT] ${result.entries} entries from ${pages} pages at anchor ${anchor} in ${Date.now() - started} ms; skipped ${JSON.stringify(result.skipped)}`
  );
  return { ...result, anchor, at };
}
