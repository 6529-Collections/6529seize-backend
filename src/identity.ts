import { ConnectionWrapper, dbSupplier } from './sql-executor';
import { identitiesDb } from './identities/identities.db';
import { IdentityEntity } from './entities/IIdentity';
import { profilesService } from './profiles/profiles.service';
import { Profile } from './entities/IProfile';
import { Logger } from './logging';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '@/constants';
import { randomUUID } from 'crypto';
import { identitySubscriptionsDb } from './api-serverless/src/identity-subscriptions/identity-subscriptions.db';
import { identitiesService } from './api-serverless/src/identities/identities.service';
import { numbers } from './numbers';
import { collections } from './collections';

const logger = Logger.get('IDENTITIES');

async function getUnsynchronisedConsolidationKeysWithTdhs(
  connection: ConnectionWrapper<any>
) {
  const db = dbSupplier();
  return await db.execute<{
    consolidation_key: string;
    tdh: number;
  }>(
    `
    select t.consolidation_key, floor(t.boosted_tdh) as tdh from tdh_consolidation t
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
    update ${IDENTITIES_TABLE}
    inner join ${PROFILES_TABLE} on ${PROFILES_TABLE}.external_id = ${IDENTITIES_TABLE}.profile_id
    set ${IDENTITIES_TABLE}.primary_address = ${PROFILES_TABLE}.primary_wallet
    where ${IDENTITIES_TABLE}.primary_address <> ${PROFILES_TABLE}.primary_wallet
  `,
    undefined,
    { wrappedConnection: connection }
  );
  logger.info(`Syncing identities primary wallets done!`);
}

function mergeDuplicates(identitiesToSave: IdentityEntity[]) {
  return Object.values(
    identitiesToSave.reduce(
      (acc, it) => {
        const profileId = it.profile_id!;
        if (!acc[profileId]) {
          acc[profileId] = it;
        } else {
          const oldIdentity = acc[profileId];
          if (oldIdentity.tdh < it.tdh) {
            const newProfileId = randomUUID();
            const oldIdentitiesNewVersion: IdentityEntity = {
              ...oldIdentity,
              profile_id: newProfileId,
              handle: null,
              normalised_handle: null,
              rep: 0,
              cic: 0,
              level_raw: oldIdentity.level_raw - oldIdentity.rep,
              classification: null,
              sub_classification: null,
              banner1: null,
              banner2: null,
              pfp: null
            };
            acc[profileId] = it;
            acc[newProfileId] = oldIdentitiesNewVersion;
          } else {
            const newProfileId = randomUUID();
            acc[newProfileId] = {
              ...it,
              profile_id: newProfileId,
              handle: null,
              normalised_handle: null,
              rep: 0,
              cic: 0,
              level_raw: it.level_raw - it.rep,
              classification: null,
              sub_classification: null,
              banner1: null,
              banner2: null,
              pfp: null
            };
          }
        }
        return acc;
      },
      {} as Record<string, IdentityEntity>
    )
  );
}

export async function syncIdentitiesWithTdhConsolidations(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Syncing identities with tdh_consolidations`);
  const newConsolidations =
    await getUnsynchronisedConsolidationKeysWithTdhs(connection);

  if (newConsolidations.length) {
    const addressesInNewConsolidationKeys = newConsolidations
      .map((it) => it.consolidation_key.split('-'))
      .flat();
    const oldDataByWallets =
      await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
        addressesInNewConsolidationKeys,
        connection
      );
    const { brandNewConsolidations, consolidationsThatNeedWork } =
      newConsolidations.reduce(
        (acc, newConsolidation) => {
          const newConsolidationsWallets =
            newConsolidation.consolidation_key.split('-');
          const isRepresentedInOldConsolidations =
            newConsolidationsWallets.some((wallet) => oldDataByWallets[wallet]);
          if (isRepresentedInOldConsolidations) {
            acc.consolidationsThatNeedWork.push(newConsolidation);
          } else {
            acc.brandNewConsolidations.push(newConsolidation);
          }
          return acc;
        },
        {
          brandNewConsolidations: [] as {
            consolidation_key: string;
            tdh: number;
          }[],
          consolidationsThatNeedWork: [] as {
            consolidation_key: string;
            tdh: number;
          }[]
        }
      );
    const brandNewIdentities: IdentityEntity[] = await Promise.all(
      brandNewConsolidations.map<Promise<IdentityEntity>>((consolidation) =>
        identitiesService
          .determinePrimaryAddress(
            consolidation.consolidation_key.split('-'),
            consolidation.consolidation_key
          )
          .then((primaryAddress) => {
            return {
              consolidation_key: consolidation.consolidation_key,
              primary_address: primaryAddress,
              profile_id: randomUUID(),
              handle: null,
              normalised_handle: null,
              tdh: consolidation.tdh,
              rep: 0,
              cic: 0,
              level_raw: consolidation.tdh,
              pfp: null,
              banner1: null,
              banner2: null,
              classification: null,
              sub_classification: null,
              xtdh: 0,
              produced_xtdh: 0,
              granted_xtdh: 0,
              xtdh_rate: 0,
              basetdh_rate: 0
            };
          })
      )
    );
    const identitiesToMerge: {
      sourceIdentities: IdentityEntity[];
      targetIdentity: IdentityEntity;
    }[] = [];
    for (const consolidationThatNeedsWork of consolidationsThatNeedWork) {
      const walletsForConsolidationThatNeedsWork =
        consolidationThatNeedsWork.consolidation_key.split('-');
      const newPrimaryAddress = await identitiesService.determinePrimaryAddress(
        walletsForConsolidationThatNeedsWork,
        consolidationThatNeedsWork.consolidation_key
      );
      let targetIdentity = oldDataByWallets[newPrimaryAddress]?.identity ??
        oldDataByWallets[0]?.identity ?? {
          consolidation_key: consolidationsThatNeedWork,
          primary_address: newPrimaryAddress,
          profile_id: randomUUID(),
          handle: null,
          normalised_handle: null,
          tdh: consolidationThatNeedsWork.tdh,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh: 0,
          xtdh_rate: 0,
          basetdh_rate: 0,
          rep: 0,
          cic: 0,
          level_raw: consolidationThatNeedsWork.tdh,
          pfp: null,
          banner1: null,
          banner2: null,
          classification: null,
          sub_classification: null
        };
      const mainProfileForNewConsolidation =
        walletsForConsolidationThatNeedsWork
          .map((it) => oldDataByWallets[it])
          .filter((it) => !!it)
          .reduce(
            (acc, data) => {
              const thisProfile = data.profile;
              const thisCic = numbers.parseIntOrNull(`${data.identity.cic}`)!;
              const thisTdh = numbers.parseIntOrNull(`${data.identity.tdh}`)!;
              if (thisProfile) {
                if (
                  !acc ||
                  thisCic > acc.cic ||
                  (thisCic === acc.cic && thisTdh > acc.tdh)
                ) {
                  return { ...thisProfile, cic: thisCic, tdh: thisTdh };
                }
              }
              return acc;
            },
            null as (Profile & { cic: number; tdh: number }) | null
          );
      targetIdentity = {
        ...targetIdentity,
        consolidation_key: consolidationThatNeedsWork.consolidation_key,
        tdh: consolidationThatNeedsWork.tdh,
        handle: mainProfileForNewConsolidation?.handle ?? null,
        normalised_handle:
          mainProfileForNewConsolidation?.normalised_handle ?? null,
        pfp: mainProfileForNewConsolidation?.pfp_url ?? null,
        banner1: mainProfileForNewConsolidation?.banner_1 ?? null,
        banner2: mainProfileForNewConsolidation?.banner_2 ?? null,
        classification: mainProfileForNewConsolidation?.classification ?? null,
        sub_classification:
          mainProfileForNewConsolidation?.sub_classification ?? null
      };
      const sourceIdentities = walletsForConsolidationThatNeedsWork
        .map((wallet) => oldDataByWallets[wallet])
        .filter((it) => !!it)
        .filter((it) => it.identity.profile_id !== targetIdentity.profile_id)
        .map((it) => it.identity);
      identitiesToMerge.push({ sourceIdentities, targetIdentity });
    }
    const allOldWallets = collections.distinct(
      Object.values(oldDataByWallets)
        .map((it) => it.identity.consolidation_key.split('-'))
        .flat()
    );
    for (const address of allOldWallets) {
      const newIdentity =
        brandNewIdentities.find((it) =>
          it.consolidation_key.split('-').includes(address)
        ) ??
        identitiesToMerge.find((it) =>
          it.targetIdentity.consolidation_key.split('-').includes(address)
        );
      if (!newIdentity) {
        brandNewIdentities.push({
          consolidation_key: address,
          primary_address: address,
          profile_id: randomUUID(),
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
          sub_classification: null,
          xtdh: 0,
          produced_xtdh: 0,
          granted_xtdh: 0,
          xtdh_rate: 0,
          basetdh_rate: 0
        });
      }
    }
    await identitiesDb.deleteAddressConsolidations(allOldWallets, connection);
    const allOldConsolidationKeys = collections.distinct(
      Object.values(oldDataByWallets).map((it) => it.identity.consolidation_key)
    );
    await identitiesDb.deleteIdentities(
      { consolidationKeys: allOldConsolidationKeys },
      connection
    );
    brandNewIdentities.push(
      ...identitiesToMerge.map((it) => it.targetIdentity)
    );
    const identitiesToSave: IdentityEntity[] = await Promise.all(
      brandNewIdentities.map((it) =>
        identitiesService
          .determinePrimaryAddress(
            it.consolidation_key.split('-'),
            it.consolidation_key
          )
          .then((primaryAddress) => ({
            ...it,
            primary_address: primaryAddress
          }))
      )
    );
    const identitiesReadyForSaving = mergeDuplicates(identitiesToSave);
    await identitiesDb.bulkInsertIdentities(
      identitiesReadyForSaving,
      connection
    );
    for (const identitiesToMergeElement of identitiesToMerge) {
      await profilesService.mergeProfileSet(
        {
          toBeMerged: identitiesToMergeElement.sourceIdentities.map(
            (it) => it.profile_id!
          ),
          target: identitiesToMergeElement.targetIdentity.profile_id!
        },
        connection
      );
    }
    if (identitiesToMerge.length > 0) {
      await identitySubscriptionsDb.resyncWaveSubscriptionsMetrics(connection);
    }
    await identitiesDb.syncProfileAddressesFromIdentitiesToProfiles(connection);
  }
  logger.info(`Syncing identities with tdh_consolidations done!`);
}

export async function syncIdentitiesMetrics(
  connection: ConnectionWrapper<any>
) {
  logger.info(`Syncing identities metrics`);
  const db = dbSupplier();
  await db.execute(
    `
    with cs as (
        select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'REP' group by 1
    ), out_of_sync_reps as (select i.profile_id, i.rep, c.rating from ${IDENTITIES_TABLE} i join cs c on c.profile_id = i.profile_id where c.rating <> i.rep)
    update ${IDENTITIES_TABLE} i
        inner join out_of_sync_reps on i.profile_id = out_of_sync_reps.profile_id
    set i.rep = out_of_sync_reps.rating where true
  `,
    undefined,
    { wrappedConnection: connection }
  );
  await db.execute(
    `
        with cs as (
            select matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter = 'CIC' group by 1
        ), out_of_sync_cics as (select i.profile_id, i.rep, c.rating from ${IDENTITIES_TABLE} i join cs c on c.profile_id = i.profile_id where c.rating <> i.cic)
        update ${IDENTITIES_TABLE} i
            inner join out_of_sync_cics on i.profile_id = out_of_sync_cics.profile_id
        set i.cic = out_of_sync_cics.rating where true
  `,
    undefined,
    { wrappedConnection: connection }
  );
  await db.execute(
    `update ${IDENTITIES_TABLE} set tdh = 0, basetdh_rate = 0`,
    undefined,
    { wrappedConnection: connection }
  );
  await db.execute(
    `
     update ${IDENTITIES_TABLE} i
            inner join ${CONSOLIDATED_WALLETS_TDH_TABLE} c  on c.consolidation_key = i.consolidation_key
        set i.tdh = c.boosted_tdh, i.basetdh_rate = c.boosted_tdh_rate
        where i.consolidation_key = c.consolidation_key
  `,
    undefined,
    { wrappedConnection: connection }
  );
  await updateAllIdentitiesLevels(connection);
  logger.info(`Syncing identities metrics done`);
}

export async function updateAllIdentitiesLevels(
  connection: ConnectionWrapper<any>
) {
  const db = dbSupplier();
  await db.execute(
    `
        update ${IDENTITIES_TABLE} set level_raw = (rep+tdh+xtdh) where level_raw <> (rep+tdh+xtdh)
  `,
    undefined,
    { wrappedConnection: connection }
  );
}
