import { ConnectionWrapper, dbSupplier } from './sql-executor';
import { identitiesDb } from './identities/identities.db';
import { IdentityEntity } from './entities/IIdentity';
import { profilesService } from './profiles/profiles.service';
import { Profile } from './entities/IProfile';
import { distinct, parseNumberOrNull } from './helpers';
import { Logger } from './logging';
import { CONSOLIDATED_WALLETS_TDH_TABLE, IDENTITIES_TABLE } from './constants';
import { randomUUID } from 'crypto';

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
  const newConsolidations = await getUnsynchronisedConsolidationKeysWithTdhs(
    connection
  );

  function mergeDuplicates(identitiesToSave: IdentityEntity[]) {
    return Object.values(
      identitiesToSave.reduce((acc, it) => {
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
      }, {} as Record<string, IdentityEntity>)
    );
  }

  if (newConsolidations.length) {
    const addressesInNewConsolidationKeys = newConsolidations
      .map((it) => it.consolidation_key.split('-'))
      .flat();
    const oldDataByWallets =
      await identitiesDb.lockEverythingRelatedToIdentitiesByAddresses(
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
        profilesService
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
              sub_classification: null
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
      const newPrimaryAddress = await profilesService.determinePrimaryAddress(
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
          .reduce((acc, data) => {
            const thisProfile = data.profile;
            const thisCic = parseNumberOrNull(`${data.identity.cic}`)!;
            const thisTdh = parseNumberOrNull(`${data.identity.tdh}`)!;
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
          }, null as (Profile & { cic: number; tdh: number }) | null);
      targetIdentity = {
        ...targetIdentity,
        consolidation_key: consolidationThatNeedsWork.consolidation_key,
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
    const allOldWallets = distinct(
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
          sub_classification: null
        });
      }
    }
    await identitiesDb.deleteAddressConsolidations(allOldWallets, connection);
    const allOldConsolidationKeys = distinct(
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
        profilesService
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
    await identitiesDb.syncProfileAddressesFromIdentitiesToProfiles(connection);
    await identitiesDb.fixIdentitiesMetrics(
      identitiesReadyForSaving.map((it) => it.profile_id!),
      connection
    );
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
                              where i.tdh <> ifnull(t.boosted_tdh, 0) limit 100000) needed_tdh_adjustments on ${IDENTITIES_TABLE} .consolidation_key = needed_tdh_adjustments.consolidation_key
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
