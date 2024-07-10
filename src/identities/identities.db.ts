import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { IdentityEntity } from '../entities/IIdentity';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  PROFILE_PROXIES_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '../constants';
import { Profile, ProfileClassification } from '../entities/IProfile';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { randomUUID } from 'crypto';
import { RateMatter } from '../entities/IRating';

const mysql = require('mysql');

export class IdentitiesDb extends LazyDbAccessCompatibleService {
  async lockEverythingRelatedToIdentitiesByAddresses(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ): Promise<
    Record<
      string,
      {
        consolidations: AddressConsolidationKey[];
        identity: IdentityEntity;
        profile: Profile | null;
      }
    >
  > {
    if (!addresses.length) {
      return {};
    }
    const consolidations = await this.db.execute<AddressConsolidationKey>(
      `
      select * from ${ADDRESS_CONSOLIDATION_KEY} where address in (:addresses) for update
    `,
      { addresses },
      { wrappedConnection: connection }
    );
    const identities = await this.db.execute<IdentityEntity>(
      `select * from ${IDENTITIES_TABLE} identity where identity.consolidation_key in (
      select distinct i.consolidation_key from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses)
      )  for update`,
      { addresses },
      { wrappedConnection: connection }
    );
    const profiles = await this.db.execute<Profile>(
      `select p.* from ${PROFILES_TABLE} p where p.external_id in (
      select distinct i.profile_id from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses) and i.handle is not null
      )  for update`,
      { addresses },
      { wrappedConnection: connection }
    );
    if (profiles.length > 0) {
      const profileIds = profiles.map((p) => p.external_id);
      await this.db.execute(
        `select 1 from ${RATINGS_TABLE} where rater_profile_id in (:profileIds) for update`,
        { profileIds },
        { wrappedConnection: connection }
      );
      await this.db.execute(
        `select 1 from ${RATINGS_TABLE} where rater_profile_id in (:profileIds) or matter_target_id in (:profileIds) for update`,
        { profileIds },
        { wrappedConnection: connection }
      );
      await this.db.execute(
        `select 1 from ${PROFILE_PROXIES_TABLE} where created_by in (:profileIds) or target_id in (:profileIds) for update`,
        { profileIds },
        { wrappedConnection: connection }
      );
    }
    return addresses.reduce((acc, address) => {
      const consolidationKeys = consolidations.filter(
        (consolidation) => consolidation.address === address
      );
      if (consolidationKeys.length > 0) {
        const consolidationKey = consolidationKeys[0].consolidation_key;
        const identity = identities.find(
          (i) => i.consolidation_key === consolidationKey
        )!;
        const profile =
          profiles.find((p) => p.external_id === identity.profile_id) ?? null;
        acc[address] = { consolidations: consolidationKeys, identity, profile };
      }
      return acc;
    }, {} as Record<string, { consolidations: AddressConsolidationKey[]; identity: IdentityEntity; profile: Profile | null }>);
  }

  public async insertIdentity(
    identityEntity: IdentityEntity,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        insert into ${IDENTITIES_TABLE} (consolidation_key,
                                         profile_id,
                                         primary_address,
                                         handle,
                                         normalised_handle,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw,
                                         pfp,
                                         banner1,
                                         banner2,
                                         classification,
                                         sub_classification)
        values (:consolidation_key,
                :profile_id,
                :primary_address,
                :handle,
                :normalised_handle,
                :tdh,
                :rep,
                :cic,
                :level_raw,
                :pfp,
                :banner1,
                :banner2,
                :classification,
                :sub_classification)
    `,
      identityEntity,
      { wrappedConnection: connection }
    );
    for (const address of identityEntity.consolidation_key.split('-')) {
      await this.db.execute(
        `
          insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
          values (:address, :consolidation_key) on duplicate key update consolidation_key = :consolidation_key
        `,
        { address, consolidation_key: identityEntity.consolidation_key },
        { wrappedConnection: connection }
      );
    }
  }

  public async insertIdentitiesOnAddressesOnly(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (!addresses.length) {
      return;
    }
    const identitiesSql = `insert into ${IDENTITIES_TABLE} (
                                         profile_id,
                                         consolidation_key,
                                         primary_address,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw)
        values ${addresses
          .map(
            (address) =>
              `(${mysql.escape(randomUUID())}, ${mysql.escape(
                address
              )}, ${mysql.escape(address)}, 0, 0, 0, 0)`
          )
          .join(',')}`;
    await this.db.execute(identitiesSql, undefined, {
      wrappedConnection: connection
    });
    const paramsSql = `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
        values ${addresses
          .map(
            (address) => `(${mysql.escape(address)}, ${mysql.escape(address)})`
          )
          .join(',')}`;
    await this.db.execute(paramsSql, undefined, {
      wrappedConnection: connection
    });
  }

  async updateIdentityProfile(
    consolidationKey: string,
    profile: {
      profile_id: string;
      handle: string;
      classification: ProfileClassification;
      normalised_handle: string;
      sub_classification: string | null;
      banner1: string | null;
      banner2: string | null;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
      update ${IDENTITIES_TABLE} 
      set profile_id = :profile_id,
          handle = :handle,
          banner2 = :banner2,
          classification = :classification,
          normalised_handle = :normalised_handle,
          sub_classification = :sub_classification,
          banner1 = :banner1
      where consolidation_key = :consolidationKey
    `,
      { consolidationKey, ...profile },
      { wrappedConnection: connection }
    );
  }

  async deleteAddressConsolidations(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (addresses.length === 0) return;
    await this.db.execute(
      `
      delete from ${ADDRESS_CONSOLIDATION_KEY} where address in (:addresses)
    `,
      { addresses },
      { wrappedConnection: connection }
    );
  }

  async deleteIdentities(
    param: { consolidationKeys: string[] },
    connection: ConnectionWrapper<any>
  ) {
    if (param.consolidationKeys.length === 0) return;
    await this.db.execute(
      `
      delete from ${IDENTITIES_TABLE} where consolidation_key in (:consolidationKeys)
    `,
      param,
      { wrappedConnection: connection }
    );
  }

  async getWalletsByProfileId(profileId: string): Promise<string[]> {
    return this.db
      .execute<{ address: string }>(
        `select a.address as address from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on a.consolidation_key = i.consolidation_key where i.profile_id = :profileId`,
        { profileId }
      )
      .then((result) => result.map((it) => it.address));
  }

  async bulkInsertIdentities(
    identities: IdentityEntity[],
    connection: ConnectionWrapper<any>
  ) {
    if (!identities.length) {
      return;
    }
    const identitiesSql = `insert into ${IDENTITIES_TABLE} (
                                         profile_id,
                                         consolidation_key,
                                         primary_address,
                                         handle,
                                         normalised_handle,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw,
                                         pfp,
                                         banner1,
                                         banner2,
                                         classification,
                                         sub_classification)
        values ${identities
          .map(
            (identity) =>
              `(${mysql.escape(identity.profile_id!)}, ${mysql.escape(
                identity.consolidation_key
              )}, ${mysql.escape(identity.primary_address)}, ${mysql.escape(
                identity.handle
              )}, ${mysql.escape(identity.normalised_handle)}, ${mysql.escape(
                identity.tdh
              )}, 0, 0, ${mysql.escape(identity.level_raw)}, ${mysql.escape(
                identity.pfp
              )}, ${mysql.escape(identity.banner1)}, ${mysql.escape(
                identity.banner2
              )}, ${mysql.escape(identity.classification)}, ${mysql.escape(
                identity.sub_classification
              )})`
          )
          .join(',')}`;
    await this.db.execute(identitiesSql, undefined, {
      wrappedConnection: connection
    });
    const addressesSql = `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
        values ${identities
          .map((identity) =>
            identity.consolidation_key
              .split('-')
              .map((address) => ({
                address,
                consolidationKey: identity.consolidation_key
              }))
              .flat()
              .map(
                ({ address, consolidationKey }) =>
                  `(${mysql.escape(address)}, ${mysql.escape(
                    consolidationKey
                  )})`
              )
          )
          .flat()
          .join(',')}`;
    await this.db.execute(addressesSql, undefined, {
      wrappedConnection: connection
    });
  }

  async getIdentityByProfileId(
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    return await this.db.oneOrNull<IdentityEntity>(
      `select * from identities where profile_id = :targetProfileId`,
      { targetProfileId },
      { wrappedConnection: connectionHolder }
    );
  }

  async syncProfileAddressesFromIdentitiesToProfiles(
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update profiles join identities on identities.profile_id = profiles.external_id
                           set profiles.primary_wallet = identities.primary_address
                           where profiles.primary_wallet != identities.primary_address`,
      undefined,
      { wrappedConnection: connection }
    );
  }

  async fixIdentitiesMetrics(
    profileIds: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (profileIds.length === 0) {
      return;
    }
    const ratings = await this.db.execute<{
      matter: RateMatter;
      profile_id: string;
      rating: number;
    }>(
      `select matter, matter_target_id as profile_id, sum(rating) as rating from ${RATINGS_TABLE} where matter_target_id in (:profileIds) group by 1, 2`,
      { profileIds },
      { wrappedConnection: connection }
    );
    const tdhsByProfileIds = await this.db.execute<{
      profile_id: string;
      tdh: number;
    }>(
      `select i.profile_id as profile_id, c.boosted_tdh as tdh from ${IDENTITIES_TABLE} i join ${CONSOLIDATED_WALLETS_TDH_TABLE} c on i.consolidation_key = c.consolidation_key where i.profile_id in (:profileIds)`,
      { profileIds },
      { wrappedConnection: connection }
    );
    for (const profileId of profileIds) {
      const cic =
        ratings.find(
          (it) => it.profile_id === profileId && it.matter === RateMatter.CIC
        )?.rating ?? 0;
      const rep =
        ratings.find(
          (it) => it.profile_id === profileId && it.matter === RateMatter.CIC
        )?.rating ?? 0;
      const tdh =
        tdhsByProfileIds.find((it) => it.profile_id === profileId)?.tdh ?? 0;
      const level = tdh + rep;
      await this.db.execute(
        `update ${IDENTITIES_TABLE} set level_raw = :level, rep = :rep, cic = :cic, tdh = :tdh where profile_id = :profileId`,
        { cic, rep: rep, profileId, level, tdh },
        { wrappedConnection: connection }
      );
    }
  }
}

export const identitiesDb = new IdentitiesDb(dbSupplier);
