import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { UserGroupEntity } from '../entities/IUserGroup';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  NFT_OWNERS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  XTDH_GRANT_TOKENS_TABLE,
  XTDH_GRANTS_TABLE
} from '../constants';
import { RateMatter } from '../entities/IRating';
import { randomUUID } from 'crypto';
import { identitiesDb } from '../identities/identities.db';
import { RequestContext } from '../request.context';
import { IdentityEntity } from '../entities/IIdentity';
import { collections } from '../collections';
import { Time } from '../time';
import { DbPoolName } from '../db-query.options';

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
                                            tdh_inclusion_strategy,
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
                                            excluded_profile_group_id,
                                            is_private,
                                            is_direct_message,
                                            is_beneficiary_of_grant_id)
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
                  :tdh_inclusion_strategy,
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
                  :excluded_profile_group_id,
                  :is_private,
                  :is_direct_message,
                  :is_beneficiary_of_grant_id)
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
    const distinctAddresses = collections.distinct(
      addresses.map((w) => w.toLowerCase())
    );
    if (addresses.length) {
      const chunkSize = 100;
      for (let i = 0; i < distinctAddresses.length; i += chunkSize) {
        const chunkOfAddresses = distinctAddresses.slice(i, i + chunkSize);
        const identities =
          await identitiesDb.getEverythingRelatedToIdentitiesByAddresses(
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
          .getEverythingRelatedToIdentitiesByAddresses(
            chunkOfAddresses,
            connection
          )
          .then((it) =>
            collections.distinct(
              Object.values(it).map((it) => it.identity.profile_id!)
            )
          );
        const alreadyInsertedProfileIds = await this.db
          .execute<{
            profile_id: string;
          }>(
            `select profile_id from ${PROFILE_GROUPS_TABLE} where profile_id in (:profileIds) and profile_group_id = :profile_group_id`,
            { profileIds, profile_group_id },
            { wrappedConnection: connection }
          )
          .then((it) => it.map((it) => it.profile_id));
        const missingProfileIds = profileIds.filter(
          (it) => !alreadyInsertedProfileIds.includes(it)
        );
        if (missingProfileIds.length) {
          await this.insertGroupChanges(missingProfileIds);
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
    authenticatedUserId: string | null,
    eligibleGroupIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<UserGroupEntity | null> {
    const opts = connection ? { wrappedConnection: connection } : undefined;
    return this.db
      .execute<UserGroupEntity>(
        `select * from ${USER_GROUPS_TABLE} where id = :id and (is_private is false or (created_by = :authenticatedUserId ${
          eligibleGroupIds.length ? ` or id in (:eligibleGroupIds)` : ``
        }))`,
        { id, authenticatedUserId, eligibleGroupIds },
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
    created_at_less_than: number | null,
    authenticatedUserId: string | null,
    eligibleGroupIds: string[],
    ctx: RequestContext
  ): Promise<UserGroupEntity[]> {
    ctx.timer?.start('userGroupsDb->searchByNameOrAuthor');
    let sql = `select * from ${USER_GROUPS_TABLE} where !is_direct_message and visible is true and (is_private is false or (created_by = :authenticatedUserId ${
      eligibleGroupIds.length ? ` or id in (:eligibleGroupIds)` : ``
    })) `;
    const params: Record<string, any> = {
      authenticatedUserId,
      eligibleGroupIds
    };
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
    const result = await this.db.execute<UserGroupEntity>(sql, params);
    ctx.timer?.stop('userGroupsDb->searchByNameOrAuthor');
    return result;
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
    ctx: RequestContext
  ): Promise<UserGroupEntity[]> {
    if (!ids.length) {
      return [];
    }

    // Deduplicate IDs to reduce query size
    const uniqueIds = collections.distinct(ids);

    ctx.timer?.start('userGroupsDb->getByIds');

    // For very large lists, batch the queries to avoid parameter limits
    if (uniqueIds.length > 100) {
      const batches = [];
      for (let i = 0; i < uniqueIds.length; i += 100) {
        batches.push(uniqueIds.slice(i, i + 100));
      }

      const results = await Promise.all(
        batches.map((batchIds) =>
          this.db.execute<UserGroupEntity>(
            `
            select *
            from ${USER_GROUPS_TABLE} 
            where id in (:ids) and visible = true
            `,
            { ids: batchIds },
            { wrappedConnection: ctx?.connection }
          )
        )
      );

      ctx.timer?.stop('userGroupsDb->getByIds');
      return results.flat();
    }

    const result = await this.db.execute<UserGroupEntity>(
      `
      select *
      from ${USER_GROUPS_TABLE} 
      where id in (:ids) and visible = true
      `,
      { ids: uniqueIds },
      { wrappedConnection: ctx?.connection }
    );
    ctx.timer?.stop('userGroupsDb->getByIds');
    return result;
  }

  async getIdentityByProfileId(
    profileId: string
  ): Promise<IdentityEntity | null> {
    const res = await this.db.oneOrNull<IdentityEntity>(
      `
      select * from ${IDENTITIES_TABLE} where profile_id = :profileId
    `,
      { profileId }
    );
    if (!res) {
      return null;
    }
    return {
      ...res,
      cic: +res.cic,
      rep: +res.rep,
      tdh: +res.tdh,
      xtdh: +res.xtdh,
      level_raw: +res.level_raw
    };
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

  async getGroupsUserIsEligibleByIdentity({
    profileId
  }: {
    profileId: string;
  }): Promise<string[]> {
    const sql = `
    select distinct ug.id as group_id 
    from (
      select profile_group_id 
      from ${PROFILE_GROUPS_TABLE} 
      where profile_id = :profileId
    ) pg
    inner join ${USER_GROUPS_TABLE} ug 
      on ug.profile_group_id = pg.profile_group_id
      and ug.visible = 1;
  `.trim();

    return this.db
      .execute<{
        group_id: string;
      }>(sql, { profileId })
      .then((res) => res.map((it) => it.group_id));
  }

  async getGroupsUserIsExcludedFromByIdentity({
    profileId
  }: {
    profileId: string;
  }): Promise<string[]> {
    const sql = `
    select distinct ug.id as group_id
    from (
      select profile_group_id 
      from ${PROFILE_GROUPS_TABLE} 
      where profile_id = :profileId
    ) pg
    inner join ${USER_GROUPS_TABLE} ug 
      on ug.excluded_profile_group_id = pg.profile_group_id
  `.trim();

    return this.db
      .execute<{
        group_id: string;
      }>(sql, { profileId })
      .then((res) => res.map((it) => it.group_id));
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
    if (!users.length && !categories.length) {
      return [];
    }
    const parts: string[] = [];
    if (users.length) {
      parts.push(`
      SELECT rater_profile_id,
             matter_target_id,
             matter,
             matter_category,
             rating
      FROM  ${RATINGS_TABLE}
      WHERE rater_profile_id  = :profileId
        AND matter_target_id IN (:users)
    `);

      parts.push(`
      SELECT rater_profile_id,
             matter_target_id,
             matter,
             matter_category,
             rating
      FROM  ${RATINGS_TABLE}
      WHERE matter_target_id  = :profileId
        AND rater_profile_id IN (:users)
    `);
    }
    if (categories.length) {
      parts.push(`
      SELECT rater_profile_id,
             matter_target_id,
             matter,
             matter_category,
             rating
      FROM  ${RATINGS_TABLE}
      WHERE matter          = 'REP'
        AND matter_category IN (:categories)
        AND matter_target_id = :profileId
    `);

      parts.push(`
      SELECT rater_profile_id,
             matter_target_id,
             matter,
             matter_category,
             rating
      FROM  ${RATINGS_TABLE}
      WHERE matter          = 'REP'
        AND matter_category IN (:categories)
        AND rater_profile_id = :profileId
    `);
    }
    const sql = `select distinct all_res.* from (${parts.join(' UNION ALL ')}) all_res`;
    return this.db.execute<{
      rater_profile_id: string;
      matter_target_id: string;
      matter: RateMatter;
      matter_category: string;
      rating: number;
    }>(sql, { profileId, users, categories });
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
    groupIds: string[],
    ctx: RequestContext
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
        { groupIds },
        { wrappedConnection: ctx.connection }
      ),
      this.db.execute<{
        group_id: string;
        excluded_identity_group_id: string;
        excluded_identity_count: number;
      }>(
        `select g.id as group_id, pg.profile_group_id as excluded_identity_group_id, count(pg.profile_id) as excluded_identity_count from ${USER_GROUPS_TABLE} g 
        join ${PROFILE_GROUPS_TABLE} pg on g.excluded_profile_group_id = pg.profile_group_id where g.id in (:groupIds) group by 1, 2`,
        { groupIds },
        { wrappedConnection: ctx.connection }
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
      const keys = collections.distinct([
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
    await this.insertGroupChanges(profileIds);
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
    await this.insertGroupChanges([targetIdentity]);
    await this.db.execute(sql, undefined, {
      wrappedConnection: connection
    });
  }

  async getAllProfileOwnedTokensByProfileIdGroupedByContract(
    profileId: string,
    ctx: RequestContext
  ): Promise<Record<string, string[]>> {
    ctx.timer?.start(
      'userGroupsDb->getAllProfileOwnedTokensByProfileIdGroupedByContract'
    );
    const result = await this.db
      .execute<{
        contract: string;
        token_ids: string;
      }>(
        `
        select o.contract as contract, group_concat(o.token_id separator ',') as token_ids
        from ${IDENTITIES_TABLE} i
                 join ${ADDRESS_CONSOLIDATION_KEY} ack on ack.consolidation_key = i.consolidation_key
                 join ${NFT_OWNERS_TABLE} o on o.wallet = ack.address
        where i.profile_id = :profileId
        group by 1
        `,
        { profileId },
        { wrappedConnection: ctx.connection }
      )
      .then((res) =>
        res.reduce(
          (acc, it) => {
            acc[it.contract.toLowerCase()] = it.token_ids
              .split(',')
              .map((k) => k.toLowerCase());
            return acc;
          },
          {} as Record<string, string[]>
        )
      );
    ctx.timer?.stop(
      'userGroupsDb->getAllProfileOwnedTokensByProfileIdGroupedByContract'
    );
    return result;
  }

  async getAllWaveRelatedGroups(ctx: RequestContext): Promise<string[]> {
    ctx.timer?.start('userGroupsDb->getAllWaveRelatedGroups');
    const result = await this.db.execute<{
      id: string;
    }>(
      `
        select distinct id from (
          select w.visibility_group_id as id from waves w
          union all
          select w.admin_group_id as id from waves w
          union all
          select w.chat_group_id as id from waves w
          union all
          select w.participation_group_id as id from waves w
          union all
          select w.voting_group_id as id from waves w
        ) x where id is not null
        `,
      undefined,
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop('userGroupsDb->getAllWaveRelatedGroups');
    return result.map((it) => it.id);
  }

  async findFollowersOfUserInGroups(
    userId: string,
    groupIds: string[],
    ctx: RequestContext
  ): Promise<string[]> {
    if (!groupIds.length) {
      return [];
    }

    return await this.db
      .execute<{ subscriber_id: string }>(
        `select distinct isub.subscriber_id from ${IDENTITY_SUBSCRIPTIONS_TABLE} isub
          join ${PROFILE_GROUPS_TABLE} pg on isub.subscriber_id = pg.profile_id
          join ${USER_GROUPS_TABLE} ug on pg.profile_group_id = ug.profile_group_id
          where isub.target_id = :userId
          and ug.id in (:groupIds)
        `,
        { userId, groupIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => res.map((it) => it.subscriber_id));
  }

  async findIdentitiesInGroups(
    groupIds: string[],
    ctx: RequestContext
  ): Promise<string[]> {
    return await this.db
      .execute<{ profile_id: string }>(
        `
          SELECT DISTINCT pg.profile_id
          FROM ${PROFILE_GROUPS_TABLE} pg
          JOIN ${USER_GROUPS_TABLE} ug ON pg.profile_group_id = ug.profile_group_id
          WHERE ug.id IN (:groupIds);
      `,
        { groupIds },
        { wrappedConnection: ctx.connection }
      )
      .then((res) => res.map((it) => it.profile_id));
  }

  public async findDirectMessageGroup(
    addresses: string[],
    ctx: RequestContext
  ): Promise<UserGroupEntity | null> {
    if (!addresses.length) return null;

    const addressPlaceholders = addresses
      .map((_, idx) => `:a${idx}`)
      .join(', ');

    const count = addresses.length;

    const sql = `
      WITH filtered_groups AS (
        SELECT
          pg.profile_group_id,
          COUNT(DISTINCT CASE WHEN i.primary_address IN (${addressPlaceholders}) THEN i.primary_address END) AS matched_count,
          COUNT(DISTINCT i.primary_address) AS total_count
        FROM ${PROFILE_GROUPS_TABLE} pg
        JOIN ${IDENTITIES_TABLE} i ON i.profile_id = pg.profile_id
        GROUP BY pg.profile_group_id
        HAVING matched_count = :count AND total_count = :count
      )
      SELECT cg.*
      FROM ${USER_GROUPS_TABLE} cg
      JOIN filtered_groups fg ON fg.profile_group_id = cg.profile_group_id
      WHERE cg.is_private = TRUE AND cg.is_direct_message = TRUE
      LIMIT 1;
    `;

    const params: Record<string, any> = {
      count
    };

    addresses.forEach((id, idx) => {
      params[`a${idx}`] = id;
    });

    const results = await this.db.execute<UserGroupEntity>(sql, params, {
      wrappedConnection: ctx.connection
    });

    return results[0] ?? null;
  }

  async profileHasRecentGroupChanges(profileId: string, interval: Time) {
    return await this.db
      .oneOrNull<{
        profile_id: string;
      }>(
        `select profile_id from ${PROFILE_GROUP_CHANGES} where profile_id = :profileId and chg_time > :limit limit 1`,
        { limit: Time.now().minus(interval).toMillis(), profileId },
        { forcePool: DbPoolName.WRITE }
      )
      .then((it) => {
        return !!it?.profile_id;
      });
  }

  async insertGroupChanges(profileIds: string[]) {
    if (!profileIds.length) return null;
    const currentMillis = Time.currentMillis();
    const sql = `INSERT INTO ${PROFILE_GROUP_CHANGES} (profile_id, chg_time) values ${profileIds.map((profileId) => `(${mysql.escape(profileId)}, ${currentMillis})`).join(', ')}`;
    await this.db.execute(sql);
  }

  async inWhichOfGrantsIsProfileBeneficiary(
    param: {
      beneficiaryGrantIds: string[];
      profileId: string;
    },
    ctx: RequestContext
  ): Promise<string[]> {
    ctx.timer?.start(
      `${this.constructor.name}->inWhichOfGrantsIsProfileBeneficiary`
    );
    try {
      const dbResults = await this.db.execute<{ grant_id: string }>(
        `
              select
                  distinct xg.id as grant_id
              from ${ADDRESS_CONSOLIDATION_KEY} a
                       join ${IDENTITIES_TABLE} i on a.consolidation_key = i.consolidation_key
                       join ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} eto on eto.owner = a.address
                       join ${XTDH_GRANTS_TABLE} xg on xg.target_partition = eto.\`partition\`
              where i.profile_id = :profileId and xg.status = 'GRANTED' and xg.token_mode = 'ALL'
              and xg.id in (:beneficiaryGrantIds)
              union all
              select
                  distinct xg.id as grant_id
              from ${XTDH_GRANTS_TABLE} xg
                      join ${XTDH_GRANT_TOKENS_TABLE} xtk on xg.token_mode = 'INCLUDE' and xtk.tokenset_id = xg.tokenset_id
                      join ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} eto on eto.\`partition\` = xg.target_partition and eto.token_id = xtk.token_id
                      join ${ADDRESS_CONSOLIDATION_KEY} ack on ack.address = eto.owner
                      join ${IDENTITIES_TABLE} i on i.consolidation_key = ack.consolidation_key
              where i.profile_id = :profileId and xg.status = 'GRANTED' and xg.token_mode = 'INCLUDE'
                and xg.id in (:beneficiaryGrantIds)
          `,
        param,
        { wrappedConnection: ctx.connection }
      );
      return dbResults.map((it) => it.grant_id);
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->inWhichOfGrantsIsProfileBeneficiary`
      );
    }
  }
}

export const userGroupsDb = new UserGroupsDb(dbSupplier);
