import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { IdentityEntity } from '../entities/IIdentity';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  PROFILE_PROXIES_TABLE,
  PROFILES_TABLE,
  RATINGS_TABLE
} from '../constants';
import { Profile, ProfileClassification } from '../entities/IProfile';
import { AddressConsolidationKey } from '../entities/IAddressConsolidationKey';
import { NotFoundException } from '../exceptions';

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
      select distinct i.profile_id from ${ADDRESS_CONSOLIDATION_KEY} a join ${IDENTITIES_TABLE} i on i.consolidation_key = a.consolidation_key where a.address in (:addresses) and i.profile_id is not null
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
    const identitiesSql = `insert into ${IDENTITIES_TABLE} (consolidation_key,
                                         primary_address,
                                         tdh,
                                         rep,
                                         cic,
                                         level_raw)
        values ${addresses
          .map(
            (address) =>
              `(${mysql.escape(address)}, ${mysql.escape(address)}, 0, 0, 0, 0)`
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
    await this.db.execute(
      `
      delete from ${IDENTITIES_TABLE} where consolidation_key in (:consolidationKeys)
    `,
      param,
      { wrappedConnection: connection }
    );
  }

  async lockEverythingRelatedToProfileIdsByProfileIdsOrThrow(
    profileIds: string[],
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
    if (!profileIds) {
      return {};
    }
    const profileIdsAndPrimaryAddresses = await this.db.execute<{
      profile_id: string;
      primary_address: string;
    }>(
      `select profile_id, primary_address from ${IDENTITIES_TABLE} where profile_id in (:profileIds) for update`,
      { profileIds },
      { wrappedConnection: connection }
    );
    const missingProfiles = profileIds.filter(
      (it) => !profileIdsAndPrimaryAddresses.some((p) => p.profile_id === it)
    );
    if (missingProfiles.length > 0) {
      throw new NotFoundException(
        `Missing profile(s) for profile id(s): ${missingProfiles.join(', ')}`
      );
    }
    return this.lockEverythingRelatedToIdentitiesByAddresses(
      profileIdsAndPrimaryAddresses.map((it) => it.primary_address),
      connection
    ).then((result) =>
      Object.values(result).reduce((acc, it) => {
        if (it.profile && profileIds.includes(it.profile.external_id)) {
          acc[it.profile.external_id] = { ...it, profile: it.profile! };
        }
        return acc;
      }, {} as Record<string, { consolidations: AddressConsolidationKey[]; identity: IdentityEntity; profile: Profile }>)
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
}

export const identitiesDb = new IdentitiesDb(dbSupplier);
