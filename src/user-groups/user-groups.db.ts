import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { UserGroupEntity } from '../entities/IUserGroup';
import {
  IDENTITIES_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE
} from '../constants';
import { RateMatter } from '../entities/IRating';
import { randomUUID } from 'crypto';
import { distinct } from '../helpers';
import { identitiesDb } from '../identities/identities.db';

const mysql = require('mysql');

export class UserGroupsDb extends LazyDbAccessCompatibleService {
  async save(entity: UserGroupEntity, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `
          insert into ${USER_GROUPS_TABLE} (id,
                                            name,
                                            cic_min,
                                            cic_max,
                                            cic_user,
                                            cic_direction,
                                            rep_min,
                                            rep_max,
                                            rep_user,
                                            rep_direction,
                                            rep_category,
                                            tdh_min,
                                            tdh_max,
                                            level_min,
                                            level_max,
                                            created_at,
                                            created_by,
                                            owns_meme,
                                            owns_meme_tokens,
                                            owns_gradient,
                                            owns_gradient_tokens,
                                            owns_nextgen,
                                            owns_nextgen_tokens,
                                            owns_lab,
                                            owns_lab_tokens,
                                            visible,
                                            profile_group_id,
                                            excluded_profile_group_id)
          values (:id,
                  :name,
                  :cic_min,
                  :cic_max,
                  :cic_user,
                  :cic_direction,
                  :rep_min,
                  :rep_max,
                  :rep_user,
                  :rep_direction,
                  :rep_category,
                  :tdh_min,
                  :tdh_max,
                  :level_min,
                  :level_max,
                  :created_at,
                  :created_by,
                  :owns_meme,
                  :owns_meme_tokens,
                  :owns_gradient,
                  :owns_gradient_tokens,
                  :owns_nextgen,
                  :owns_nextgen_tokens,
                  :owns_lab,
                  :owns_lab_tokens,
                  :visible,
                  :profile_group_id,
                  :excluded_profile_group_id)
    `,
      { ...entity },
      { wrappedConnection: connection }
    );
  }

  async insertGroupEntriesAndGetGroupIds(
    addresses: string[],
    connection: ConnectionWrapper<any>
  ): Promise<{ profile_group_id: string }> {
    const profile_group_id = randomUUID();
    const distinctAddresses = distinct(addresses.map((w) => w.toLowerCase()));
    if (addresses.length) {
      const chunkSize = 100;
      for (let i = 0; i < distinctAddresses.length; i += chunkSize) {
        const chunkOfAddresses = distinctAddresses.slice(i, i + chunkSize);
        const identities =
          await identitiesDb.lockEverythingRelatedToIdentitiesByAddresses(
            chunkOfAddresses,
            connection
          );
        const missingIdentities = chunkOfAddresses.filter(
          (a) => !identities[a]
        );
        await identitiesDb.insertIdentitiesOnAddressesOnly(
          missingIdentities,
          connection
        );
        const profileIds = await identitiesDb
          .lockEverythingRelatedToIdentitiesByAddresses(
            chunkOfAddresses,
            connection
          )
          .then((it) =>
            distinct(Object.values(it).map((it) => it.identity.profile_id!))
          );
        const alreadyInsertedProfileIds = await this.db
          .execute<{ profile_id: string }>(
            `select profile_id from ${PROFILE_GROUPS_TABLE} where profile_id in (:profileIds) and profile_group_id = :profile_group_id`,
            { profileIds, profile_group_id },
            { wrappedConnection: connection }
          )
          .then((it) => it.map((it) => it.profile_id));
        const missingProfileIds = profileIds.filter(
          (it) => !alreadyInsertedProfileIds.includes(it)
        );
        if (missingProfileIds.length) {
          let sql = `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
                 values `;
          for (const profileId of missingProfileIds) {
            sql += `(${mysql.escape(profile_group_id)}, ${mysql.escape(
              profileId
            )}),`;
          }
          await this.db.execute(sql.slice(0, sql.length - 1), undefined, {
            wrappedConnection: connection
          });
        }
      }
    }
    return { profile_group_id };
  }

  async getById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<UserGroupEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute<UserGroupEntity>(
        `select * from ${USER_GROUPS_TABLE} where id = :id`,
        { id },
        opts
      )
      .then((res) => res[0] ?? null);
  }

  async changeVisibilityAndSetId(
    {
      currentId,
      newId,
      visibility
    }: { currentId: string; newId: string | null; visibility: boolean },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${USER_GROUPS_TABLE} set visible = :visible where id = :currentId`,
      { currentId, visible: visibility },
      { wrappedConnection: connection }
    );
    if (newId) {
      await this.db.execute(
        `update ${USER_GROUPS_TABLE} set id = :newId where id = :currentId`,
        { currentId, newId, visible: visibility },
        { wrappedConnection: connection }
      );
    }
  }

  async searchByNameOrAuthor(
    name: string | null,
    authorId: string | null,
    created_at_less_than: number | null
  ): Promise<UserGroupEntity[]> {
    let sql = `select * from ${USER_GROUPS_TABLE} where visible is true `;
    const params: Record<string, any> = {};
    if (name) {
      sql += ` and name like :name `;
      params.name = `%${name}%`;
    }
    if (authorId) {
      sql += ` and created_by = :created_by `;
      params.created_by = authorId;
    }
    if (created_at_less_than) {
      sql += ` and created_at < :created_at_less_than `;
      params.created_at_less_than = new Date(created_at_less_than);
    }
    sql += ` order by created_at desc limit 20`;
    return this.db.execute<UserGroupEntity>(sql, params);
  }

  async deleteById(id: string, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `delete from ${USER_GROUPS_TABLE} where id = :id`,
      { id },
      { wrappedConnection: connection }
    );
  }

  async getByIds(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<UserGroupEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute<UserGroupEntity>(
      `
    select * from ${USER_GROUPS_TABLE} where visible is true and id in (:ids)
    `,
      { ids },
      { wrappedConnection: connection }
    );
  }

  async getProfileOverviewByProfileId(profileId: string): Promise<{
    profile_id: string;
    tdh: number;
    level: number;
    cic: number;
    rep: number;
  }> {
    return this.db
      .execute<{
        profile_id: string;
        tdh: number;
        level: number;
        cic: number;
        rep: number;
      }>(
        `
      select profile_id, tdh, level_raw as level, cic, rep from ${IDENTITIES_TABLE} where profile_id = :profileId
    `,
        { profileId }
      )
      .then((res) => res[0] ?? null);
  }

  async getGivenCicAndRep(
    profileId: string
  ): Promise<{ cic: number; rep: number }> {
    return this.db
      .execute<{
        matter: string;
        rating: number;
      }>(
        `select matter, sum(rating) as rating from ratings where rater_profile_id = :profileId group by 1`,
        { profileId }
      )
      .then((res) =>
        res.reduce(
          (acc, { matter, rating }) => {
            if (matter === RateMatter.CIC) {
              acc.cic += rating;
            }
            if (matter === RateMatter.REP) {
              acc.rep += rating;
            }
            return acc;
          },
          { cic: 0, rep: 0 }
        )
      );
  }

  async getGroupsUserIsEligibleByIdentity(
    profileId: string
  ): Promise<string[]> {
    return this.db
      .execute<{
        group_id: string;
      }>(
        `select distinct ug.id as group_id from ${PROFILE_GROUPS_TABLE} pg join ${USER_GROUPS_TABLE} ug on ug.profile_group_id = pg.profile_group_id where pg.profile_id = :profileId and ug.visible`,
        { profileId }
      )
      .then((res) => res.map((it) => it.group_id));
  }

  async getGroupsUserIsExcludedFromByIdentity(
    profileId: string
  ): Promise<string[]> {
    return this.db
      .execute<{
        group_id: string;
      }>(
        `select distinct ug.id from ${PROFILE_GROUPS_TABLE} pg join ${USER_GROUPS_TABLE} ug on ug.excluded_profile_group_id = pg.profile_group_id where pg.profile_id = :profileId`,
        { profileId }
      )
      .then((res) => res.map((it) => it.group_id));
  }

  async getGroupsMatchingConditions(param: {
    level: number;
    givenCic: number;
    givenRep: number;
    profileId: string | null;
    tdh: number;
    receivedCic: number;
    receivedRep: number;
  }): Promise<UserGroupEntity[]> {
    const sql = `
    select cg.*
from ${USER_GROUPS_TABLE} cg
where ((cg.cic_direction = 'RECEIVED' and (
    (cg.cic_min is null or :receivedCic >= cg.cic_min) and
    (cg.cic_max is null or :receivedCic >= cg.cic_max) and
    (cg.cic_user is null ${
      param.profileId ? ` or cg.cic_user = :profileId ` : ``
    })
    )) or (cg.cic_direction = 'SENT' and (
    (cg.cic_min is null or :givenCic >= cg.cic_min) and
    (cg.cic_max is null or :givenCic >= cg.cic_max)
    )))
  and ((cg.rep_direction = 'RECEIVED' and (
    (cg.rep_min is null or :receivedRep >= cg.rep_min) and
    (cg.rep_max is null or :receivedRep >= cg.rep_max) and
    (cg.rep_user is null ${
      param.profileId ? ` or cg.rep_user = :profileId ` : ``
    })
    )) or (cg.rep_direction = 'SENT' and (
    (cg.rep_min is null or :givenRep >= cg.rep_min) and
    (cg.rep_max is null or :givenRep >= cg.rep_max)
    )))
  and (cg.level_min is null or :level >= cg.level_min)
  and (cg.level_max is null or :level <= cg.level_max)
  and (cg.tdh_min is null or :tdh >= cg.tdh_min)
  and (cg.tdh_max is null or :tdh <= cg.tdh_max)
  and cg.visible = true`;
    return this.db.execute(sql, param);
  }

  async getRatings(
    profileId: string,
    users: string[],
    categories: string[]
  ): Promise<
    {
      rater_profile_id: string;
      matter_target_id: string;
      matter: RateMatter;
      matter_category: string;
      rating: number;
    }[]
  > {
    if (users.length === 0 && !categories.length) {
      return [];
    }
    return this.db.execute<{
      rater_profile_id: string;
      matter_target_id: string;
      matter: RateMatter;
      matter_category: string;
      rating: number;
    }>(
      `select 
      rater_profile_id, 
      matter_target_id,
      matter, 
      matter_category,
      rating as rating from ${RATINGS_TABLE} where 
      ${
        users.length
          ? `
      (rater_profile_id = :profileId and matter_target_id in (:users)) 
      or (matter_target_id = :profileId and rater_profile_id in (:users))
      `
          : ``
      }
      ${users.length && categories.length ? `or` : ``}
      ${
        categories.length
          ? `
      (matter = 'REP' and matter_category in (:categories) and matter_target_id = :profileId or rater_profile_id = :profileId)
      `
          : ``
      }`,
      { profileId, users, categories }
    );
  }

  async migrateProfileIdsInGroups(
    old_profile_id: string,
    new_profile_id: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await Promise.all([
      this.db.execute(
        `update ${USER_GROUPS_TABLE} set created_by = :new_profile_id where created_by = :old_profile_id`,
        { old_profile_id, new_profile_id },
        { wrappedConnection: connectionHolder }
      ),
      this.db.execute(
        `update ${USER_GROUPS_TABLE} set cic_user = :new_profile_id where cic_user = :old_profile_id`,
        { old_profile_id, new_profile_id },
        { wrappedConnection: connectionHolder }
      ),
      this.db.execute(
        `update ${USER_GROUPS_TABLE} set rep_user = :new_profile_id where rep_user = :old_profile_id`,
        { old_profile_id, new_profile_id },
        { wrappedConnection: connectionHolder }
      )
    ]);
  }

  async findIdentityGroupsIdsAndIdentityCountsByGroupIds(
    groupIds: string[]
  ): Promise<
    Record<
      string,
      {
        identity_group_id: string | null;
        identity_count: number;
        excluded_identity_group_id: string | null;
        excluded_identity_count: number;
      }
    >
  > {
    if (!groupIds.length) {
      return {};
    }
    return Promise.all([
      this.db.execute<{
        group_id: string;
        identity_group_id: string;
        identity_count: number;
      }>(
        `select g.id as group_id, pg.profile_group_id as identity_group_id, count(pg.profile_id) as identity_count from ${USER_GROUPS_TABLE} g 
        join ${PROFILE_GROUPS_TABLE} pg on g.profile_group_id = pg.profile_group_id where g.id in (:groupIds) group by 1, 2`,
        { groupIds }
      ),
      this.db.execute<{
        group_id: string;
        excluded_identity_group_id: string;
        excluded_identity_count: number;
      }>(
        `select g.id as group_id, pg.profile_group_id as excluded_identity_group_id, count(pg.profile_id) as excluded_identity_count from ${USER_GROUPS_TABLE} g 
        join ${PROFILE_GROUPS_TABLE} pg on g.excluded_profile_group_id = pg.profile_group_id where g.id in (:groupIds) group by 1, 2`,
        { groupIds }
      )
    ]).then((results) => {
      const [res1, res2] = results;
      const includedIdentities = res1.reduce(
        (acc, { group_id, identity_group_id, identity_count }) => {
          acc[group_id] = { identity_group_id, identity_count };
          return acc;
        },
        {} as Record<
          string,
          { identity_group_id: string; identity_count: number }
        >
      );
      const excludedIdentities = res2.reduce(
        (
          acc,
          { group_id, excluded_identity_group_id, excluded_identity_count }
        ) => {
          acc[group_id] = {
            excluded_identity_group_id,
            excluded_identity_count
          };
          return acc;
        },
        {} as Record<
          string,
          {
            excluded_identity_group_id: string;
            excluded_identity_count: number;
          }
        >
      );
      const keys = distinct([
        ...Object.keys(includedIdentities),
        ...Object.keys(excludedIdentities)
      ]);
      return keys.reduce(
        (acc, key) => {
          acc[key] = {
            identity_group_id:
              includedIdentities[key]?.identity_group_id ?? null,
            identity_count: includedIdentities[key]?.identity_count ?? 0,
            excluded_identity_group_id:
              excludedIdentities[key]?.excluded_identity_group_id ?? null,
            excluded_identity_count:
              excludedIdentities[key]?.excluded_identity_count ?? 0
          };
          return acc;
        },
        {} as Record<
          string,
          {
            identity_group_id: string | null;
            identity_count: number;
            excluded_identity_group_id: string | null;
            excluded_identity_count: number;
          }
        >
      );
    });
  }

  async findUserGroupsIdentityGroupPrimaryAddresses(
    identityGroupId: string
  ): Promise<string[]> {
    return this.db
      .execute<{ address: string }>(
        `select i.primary_address as address from ${PROFILE_GROUPS_TABLE} pg 
        join ${IDENTITIES_TABLE} i on i.profile_id = pg.profile_id where pg.profile_group_id = :identityGroupId`,
        { identityGroupId }
      )
      .then((res) => res.map((it) => it.address));
  }

  async findProfileGroupsWhereProfileIdIn(
    profileId: string,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<string[]> {
    return await this.db
      .execute<{ profile_group_id: string }>(
        `
      select profile_group_id from ${PROFILE_GROUPS_TABLE} where profile_id = :profileId
    `,
        { profileId },
        { wrappedConnection: connectionHolder }
      )
      .then((result) => result.map((it) => it.profile_group_id));
  }

  async deleteProfileIdsInProfileGroups(
    profileIds: string[],
    connectionHolder: ConnectionWrapper<any>
  ) {
    if (!profileIds.length) {
      return;
    }
    await this.db.execute(
      `delete from ${PROFILE_GROUPS_TABLE} where profile_id in (:profileIds)`,
      { profileIds },
      { wrappedConnection: connectionHolder }
    );
  }

  async insertProfileIdsInProfileGroups(
    targetIdentity: string,
    profileGroupIds: string[],
    connection: ConnectionWrapper<any>
  ) {
    if (!profileGroupIds.length) {
      return;
    }
    const sql = `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id) values ${profileGroupIds
      .map(
        (profileGroupId) =>
          `(${mysql.escape(profileGroupId)}, ${mysql.escape(targetIdentity)}) `
      )
      .join(',')}`;
    await this.db.execute(sql, undefined, {
      wrappedConnection: connection
    });
  }
}

export const userGroupsDb = new UserGroupsDb(dbSupplier);
