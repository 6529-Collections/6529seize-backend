import { ConnectionWrapper, dbSupplier } from './sql-executor';
import { buildConsolidationKey } from './helpers';
import {
  COMMUNITY_MEMBERS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  ENS_TABLE
} from './constants';
import { Time } from './time';
import { Logger } from './logging';

const logger = Logger.get('COMMUNITY_MEMBERS');

export async function synchroniseCommunityMembersTable(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Refreshing community members table...`);
  const db = dbSupplier();
  const time = Time.now();
  const ensWallets: Set<string> = await db
    .execute(`select lower(wallet) as wallet from ${ENS_TABLE}`, undefined, {
      wrappedConnection: connection
    })
    .then(
      (result: { wallet: string }[]) => new Set(result.map((it) => it.wallet))
    );
  const tdhWalletsResponse: { wallets: string }[] = await db.execute(
    `select wallets from ${CONSOLIDATED_WALLETS_TDH_TABLE}`,
    undefined,
    { wrappedConnection: connection }
  );
  const communityMembers = tdhWalletsResponse.reduce(
    (groups, walletsWrapped) => {
      const wallets: string[] = JSON.parse(walletsWrapped.wallets);
      wallets.forEach((it) => ensWallets.delete(it.toLowerCase()));
      groups[buildConsolidationKey(wallets)] = wallets.map((it) =>
        it.toLowerCase()
      );
      return groups;
    },
    {} as Record<string, string[]>
  );
  for (const ensWallet of Array.from(ensWallets)) {
    communityMembers[buildConsolidationKey([ensWallet])] = [ensWallet];
  }
  const newKeys = Object.keys(communityMembers);
  const oldKeys = await db
    .execute(
      `select lower(consolidation_key) as consolidation_key from ${COMMUNITY_MEMBERS_TABLE}`,
      undefined,
      { wrappedConnection: connection }
    )
    .then((result: { consolidation_key: string }[]) =>
      result.map((it) => it.consolidation_key)
    );

  const keysToDelete = oldKeys.filter((it) => !newKeys.includes(it));
  const keysToAdd = newKeys.filter((it) => !oldKeys.includes(it));

  for (let i = 0; i < keysToDelete.length; i += 10) {
    const keys = keysToDelete.slice(i, i + 10);
    await db.execute(
      `delete from ${COMMUNITY_MEMBERS_TABLE} where consolidation_key in (:keys)`,
      { keys },
      { wrappedConnection: connection }
    );
  }
  for (const key of keysToAdd) {
    const communityMember = communityMembers[key]!;
    await db.execute(
      `insert into ${COMMUNITY_MEMBERS_TABLE} (consolidation_key, wallet1, wallet2, wallet3) values (:consolidationKey, :wallet1, :wallet2, :wallet3)`,
      {
        consolidationKey: key,
        wallet1: communityMember[0]!,
        wallet2: communityMember[1] ?? null,
        wallet3: communityMember[2] ?? null
      },
      { wrappedConnection: connection }
    );
  }
  logger.info(
    `Finished deleting ${keysToDelete.length} and adding ${
      keysToAdd.length
    } rows in community members table in ${time.diffFromNow()}`
  );
}
