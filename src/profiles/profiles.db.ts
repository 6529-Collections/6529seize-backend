import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { DROPS_TABLE, PROFILES_TABLE, WAVES_TABLE } from '@/constants';
import { Profile } from '../entities/IProfile';
import { CreateOrUpdateProfileCommand } from './profile.types';
import { RequestContext } from '../request.context';
import { identitiesDb } from '../identities/identities.db';

const mysql = require('mysql');

export class ProfilesDb extends LazyDbAccessCompatibleService {
  private async insertProfileArchiveRecord(
    param: Profile,
    connection: ConnectionWrapper<any>
  ) {
    await identitiesDb.insertProfileArchiveRecord(
      {
        profile_id: param.external_id,
        normalised_handle: param.normalised_handle,
        handle: param.handle,
        pfp: param.pfp_url ?? null,
        banner1: param.banner_1 ?? null,
        banner2: param.banner_2 ?? null,
        classification: param.classification ?? null,
        sub_classification: param.sub_classification ?? null,
        primary_address: param.primary_wallet
      },
      connection
    );
  }

  public async updateProfileRecord(
    {
      command,
      oldHandle
    }: {
      command: CreateOrUpdateProfileCommand;
      oldHandle: string;
    },
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.db.execute(
      `update ${PROFILES_TABLE}
       set handle            = :handle,
           normalised_handle = :normalisedHandle,
           updated_at        = current_time,
           updated_by_wallet = :updatedByWallet,
           banner_1          = :banner1,
           banner_2          = :banner2,
           website           = :website,
           classification    = :classification,
           pfp_url           = :pfp_url
       where normalised_handle = :oldHandle`,
      {
        oldHandle,
        handle: command.handle,
        normalisedHandle: command.handle.toLowerCase(),
        updatedByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification,
        pfp_url: command.pfp_url
      },
      { wrappedConnection: connection }
    );
    const profile = await this.getProfileByHandle(command.handle, connection);
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connection);
    }
  }

  public async insertProfileRecord(
    id: string,
    {
      command
    }: {
      command: CreateOrUpdateProfileCommand;
    },
    connection: ConnectionWrapper<any>
  ) {
    const wallet = command.creator_or_updater_wallet.toLowerCase();
    await this.db.execute(
      `insert into ${PROFILES_TABLE}
       (handle,
        normalised_handle,
        primary_wallet,
        created_at,
        created_by_wallet,
        banner_1,
        banner_2,
        website,
        classification,
        external_id,
        sub_classification,
        pfp_url)
       values (:handle,
               :normalisedHandle,
               :primaryWallet,
               current_time,
               :createdByWallet,
               :banner1,
               :banner2,
               :website,
               :classification,
               :externalId,
               :subClassification,
               :pfp_url)`,
      {
        handle: command.handle,
        normalisedHandle: command.handle.toLowerCase(),
        primaryWallet: wallet,
        createdByWallet: command.creator_or_updater_wallet.toLowerCase(),
        banner1: command.banner_1 ?? null,
        banner2: command.banner_2 ?? null,
        website: command.website ?? null,
        classification: command.classification,
        externalId: id,
        subClassification: command.sub_classification,
        pfp_url: command.pfp_url
      },
      { wrappedConnection: connection }
    );
    const profile = await this.getProfileByHandle(command.handle, connection);
    if (profile) {
      await this.insertProfileArchiveRecord(profile, connection);
    }
  }

  async deleteProfile(
    { id }: { id: string },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${PROFILES_TABLE} where external_id = :id`,
      { id },
      { wrappedConnection: connectionHolder }
    );
  }

  async getProfileById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Profile | null> {
    return this.db.oneOrNull<Profile>(
      `select * from ${PROFILES_TABLE} where external_id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async updateProfileId(
    param: { from: string; to: string },
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${PROFILES_TABLE} set external_id = :to where external_id = :from`,
      param,
      { wrappedConnection: connectionHolder }
    );
  }

  async migrateAuthorIdsInWaves(
    profileToBeMerged: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${WAVES_TABLE} set created_by = :target where created_by = :profileToBeMerged`,
      { profileToBeMerged, target },
      { wrappedConnection: connectionHolder }
    );
  }

  async migrateAuthorIdsInDrops(
    profileToBeMerged: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${DROPS_TABLE} set author_id = :target where author_id = :profileToBeMerged`,
      { profileToBeMerged, target },
      { wrappedConnection: connectionHolder }
    );
  }

  async bulkInsertProfiles(profiles: Profile[], ctx: RequestContext) {
    if (!profiles.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->bulkInsertProfiles`);
    const sql = `
        insert into ${PROFILES_TABLE} (
            external_id,
            handle,
            normalised_handle,
            primary_wallet,
            created_at,
            created_by_wallet,
            banner_1,
            banner_2,
            website,
            classification,
            sub_classification
        ) values ${profiles
          .map(
            (profile) =>
              `(${[
                profile.external_id,
                profile.handle,
                profile.normalised_handle,
                profile.primary_wallet,
                profile.created_at,
                profile.created_by_wallet,
                profile.banner_1,
                profile.banner_2,
                profile.website,
                profile.classification,
                profile.sub_classification
              ]
                .map((it) => mysql.escape(it))
                .join(', ')})`
          )
          .join(', ')}
    `;
    await this.db.execute(sql, undefined, {
      wrappedConnection: ctx.connection
    });
    ctx.timer?.stop(`${this.constructor.name}->bulkInsertProfiles`);
  }

  private async getProfileByHandle(
    handle: string,
    connection?: ConnectionWrapper<any>
  ): Promise<Profile | null> {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    const result = await this.db
      .execute(
        `select * from ${PROFILES_TABLE} where normalised_handle = :handle`,
        { handle: handle.toLowerCase() },
        opts
      )
      .then((result) =>
        result.map((profile: Profile) => {
          profile.created_at = new Date(profile.created_at);
          profile.updated_at = profile.updated_at
            ? new Date(profile.updated_at)
            : null;
          return profile;
        })
      );
    return result.at(0) ?? null;
  }
}

export const profilesDb = new ProfilesDb(dbSupplier);
