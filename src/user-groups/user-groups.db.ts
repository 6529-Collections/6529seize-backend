import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { UserGroupEntity } from '../entities/ICommunityGroup';
import { PROFILE_FULL, RATINGS_TABLE, USER_GROUPS_TABLE } from '../constants';
import { RateMatter } from '../entities/IRating';

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
                                            visible)
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
                  :visible)
    `,
      { ...entity },
      { wrappedConnection: connection }
    );
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
    authorId: string | null
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

  async getByIds(ids: string[]): Promise<UserGroupEntity[]> {
    if (!ids.length) {
      return [];
    }
    return this.db.execute<UserGroupEntity>(
      `
    select * from ${USER_GROUPS_TABLE} where visible is true and id in (:ids)
    `,
      { ids }
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
      select external_id as profile_id, profile_tdh as tdh, profile_tdh + rep_score as level, cic_score as cic, rep_score as rep from ${PROFILE_FULL} where external_id = :profileId
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
}

export const userGroupsDb = new UserGroupsDb(dbSupplier);
