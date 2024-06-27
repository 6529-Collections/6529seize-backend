import { ConnectionWrapper, dbSupplier } from './sql-executor';
import { identitiesDb } from './identities/identities.db';
import { IdentityEntity } from './entities/IIdentity';
import { profilesService } from './profiles/profiles.service';
import { Profile } from './entities/IProfile';
import { ratingsDb } from './rates/ratings.db';
import { RateMatter } from './entities/IRating';
import { distinct, parseIntOrNull } from './helpers';
import { Logger } from './logging';
import { CONSOLIDATED_WALLETS_TDH_TABLE, IDENTITIES_TABLE } from './constants';

const logger = Logger.get('IDENTITIES');

async function getUnsynchronisedConsolidationKeysWithTdhs(
  connection: ConnectionWrapper<any>
) {
  const db = dbSupplier();
  return await db.execute<{ consolidation_key: string; tdh: number }>(
    `
    select t.consolidation_key, t.boosted_tdh as tdh from tdh_consolidation t
      left join address_consolidation_keys a on t.consolidation_key = a.consolidation_key
      where a.consolidation_key is null
  `,
    undefined,
    { wrappedConnection: connection }
  );
}

export async function syncIdentitiesPrimaryWallets(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Syncing identities primary wallets`);
  const db = dbSupplier();
  await db.execute<{ consolidation_key: string; tdh: number }>(
    `
    update identities
    inner join profiles on profiles.external_id = identities.profile_id
    set identities.primary_address = profiles.primary_wallet
    where identities.primary_address <> profiles.primary_wallet
  `,
    undefined,
    { wrappedConnection: connection }
  );
  logger.info(`Syncing identities primary wallets done!`);
}

export async function syncIdentitiesWithTdhConsolidations(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Syncing identities with tdh_consolidations`);
  const newConsolidationKeys = await getUnsynchronisedConsolidationKeysWithTdhs(
    connection
  );
  if (newConsolidationKeys.length > 0) {
    const affectedWallets = newConsolidationKeys
      .map((it) => it.consolidation_key.split('-'))
      .flat();
    const oldDataByWallets =
      await identitiesDb.lockEverythingRelatedToIdentitiesByAddresses(
        affectedWallets,
        connection
      );
    const oldConsolidationKeys = Object.values(oldDataByWallets)
      .map((it) => it.identity.consolidation_key)
      .filter((it) => it);
    const allWalletsInOldStateOfIdentities = oldConsolidationKeys
      .map((it) => it.split('-'))
      .flat();
    if (oldConsolidationKeys.length > 0) {
      logger.info(`Deleting identitie(s): ${oldConsolidationKeys.join(`, `)}`);
      await identitiesDb.deleteIdentities(
        { consolidationKeys: oldConsolidationKeys },
        connection
      );
    }
    const identities = await Promise.all(
      newConsolidationKeys.map<Promise<IdentityEntity>>((consolidationKey) =>
        profilesService
          .determinePrimaryAddress(
            consolidationKey.consolidation_key.split('-'),
            consolidationKey.consolidation_key
          )
          .then((primaryAddress) => {
            return {
              consolidation_key: consolidationKey.consolidation_key,
              primary_address: primaryAddress,
              profile_id: null,
              handle: null,
              normalised_handle: null,
              tdh: consolidationKey.tdh,
              rep: 0,
              cic: 0,
              level_raw: 0,
              pfp: null,
              banner1: null,
              banner2: null,
              classification: null,
              sub_classification: null
            };
          })
      )
    );
    const affectedProfiles = Object.values(oldDataByWallets)
      .map((it) => it.profile)
      .filter((it) => it) as Profile[];
    const identitiesWithAffectedProfiles = identities.map((identity) => ({
      identity,
      profiles:
        affectedProfiles.filter((profile) =>
          identity.consolidation_key.split('-').includes(profile.primary_wallet)
        ) ?? null
    }));
    const affectedProfilesIds = affectedProfiles.map((it) => it.external_id);
    const affectedProfilesCics = await ratingsDb.getMatterRatingForEachTarget(
      {
        target_profile_ids: affectedProfilesIds,
        matter: RateMatter.CIC
      },
      connection
    );
    const profilesToArchive: { source: Profile; destination: Profile }[] = [];
    const identitiesWithProfiles =
      identitiesWithAffectedProfiles.map<IdentityEntity>((it) => {
        const distinctProfiles = it.profiles.reduce((acc, profile) => {
          if (!acc.find((p) => p.external_id === profile.external_id)) {
            acc.push(profile);
          }
          return acc;
        }, [] as Profile[]);
        distinctProfiles.sort(
          (a, d) =>
            (affectedProfilesCics[d.external_id] ?? 0) -
            (affectedProfilesCics[a.external_id] ?? 0)
        );
        const mainProfile = distinctProfiles[0];
        const otherProfiles = distinctProfiles.slice(1);
        for (const otherProfile of otherProfiles) {
          profilesToArchive.push({
            source: otherProfile,
            destination: mainProfile
          });
        }
        return {
          ...it.identity,
          profile_id: mainProfile?.external_id ?? null,
          handle: mainProfile?.handle ?? null,
          normalised_handle: mainProfile?.normalised_handle ?? null,
          pfp: mainProfile?.pfp_url ?? null,
          banner1: mainProfile?.banner_1 ?? null,
          banner2: mainProfile?.banner_2 ?? null,
          classification: mainProfile?.classification ?? null,
          sub_classification: mainProfile?.sub_classification ?? null
        };
      });
    for (const profilesToArchiveElement of profilesToArchive) {
      await profilesService.mergeProfileSet(
        {
          toBeMerged: [profilesToArchiveElement.source],
          target: profilesToArchiveElement.destination
        },
        connection
      );
    }
    await identitiesDb.deleteAddressConsolidations(
      distinct([...allWalletsInOldStateOfIdentities, ...affectedWallets]),
      connection
    );
    const [reps, cics] = await Promise.all([
      ratingsDb.getMatterRatingForEachTarget(
        {
          target_profile_ids: affectedProfilesIds,
          matter: RateMatter.REP
        },
        connection
      ),
      ratingsDb.getMatterRatingForEachTarget(
        {
          target_profile_ids: affectedProfilesIds,
          matter: RateMatter.CIC
        },
        connection
      )
    ]);
    const newIdentities = identitiesWithProfiles.map((it) => {
      const rep =
        parseIntOrNull(`${it.profile_id ? reps[it.profile_id] ?? 0 : 0}`) ?? 0;
      const cic =
        parseIntOrNull(`${it.profile_id ? cics[it.profile_id] ?? 0 : 0}`) ?? 0;
      const tdh = parseIntOrNull(`${it.tdh}`) ?? 0;
      const level_raw = tdh + rep;
      return {
        ...it,
        rep,
        cic,
        level_raw
      };
    });
    const abandonedIdentities = distinct(allWalletsInOldStateOfIdentities)
      .filter((it) => !affectedWallets.includes(it))
      .map<IdentityEntity>((address) => ({
        consolidation_key: address,
        primary_address: address,
        profile_id: null,
        handle: null,
        normalised_handle: null,
        tdh: 0,
        rep: 0,
        cic: 0,
        level_raw: 0,
        pfp: null,
        banner1: null,
        banner2: null,
        classification: null,
        sub_classification: null
      }));
    const finalNewIdentities = [...newIdentities, ...abandonedIdentities];
    for (const identityEntity of finalNewIdentities) {
      logger.info(`Inserted identity ${identityEntity.consolidation_key}`);
      await identitiesDb.insertIdentity(identityEntity, connection);
    }
  }
  logger.info(`Syncing identities with tdh_consolidations done!`);
}

export async function syncIdentitiesTdhNumbers(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Syncing identities TDH numbers`);
  let moreToDo = true;
  while (moreToDo) {
    await dbSupplier().execute(
      `
    update ${IDENTITIES_TABLE} inner join (select i.consolidation_key, ifnull(t.boosted_tdh, 0) - i.tdh as tdh_adjustment
                              from ${IDENTITIES_TABLE} i
                                       left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = i.consolidation_key
                              where i.tdh <> ifnull(t.boosted_tdh, 0) limit 1000) needed_tdh_adjustments on ${IDENTITIES_TABLE} .consolidation_key = needed_tdh_adjustments.consolidation_key
    set ${IDENTITIES_TABLE}.tdh       = ${IDENTITIES_TABLE}.tdh + needed_tdh_adjustments.tdh_adjustment,
        ${IDENTITIES_TABLE}.level_raw = ${IDENTITIES_TABLE}.level_raw + needed_tdh_adjustments.tdh_adjustment
  `,
      undefined,
      { wrappedConnection: connection }
    );
    moreToDo = await dbSupplier()
      .execute(
        `
    select 1 as smth from ${IDENTITIES_TABLE} inner join (select i.consolidation_key, ifnull(t.boosted_tdh, 0) - i.tdh as tdh_adjustment
from ${IDENTITIES_TABLE} i
         left join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = i.consolidation_key
where i.tdh <> ifnull(t.boosted_tdh, 0)) needed_tdh_adjustments on needed_tdh_adjustments.consolidation_key = identities.consolidation_key limit 1
  `,
        undefined,
        { wrappedConnection: connection }
      )
      .then((result) => result.length > 0);
  }
  logger.info(`Syncing identities TDH numbers done!`);
}
