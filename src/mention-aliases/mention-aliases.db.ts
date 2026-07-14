import {
  IDENTITIES_TABLE,
  MENTION_ALIASES_TABLE,
  MENTION_ALIAS_MEMBERS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { MAX_MEMBERS_PER_MENTION_ALIAS } from './mention-aliases.constants';

export interface MentionAliasMember {
  readonly profile_id: string;
  readonly handle: string;
  readonly pfp: string | null;
}

export interface MentionAlias {
  readonly id: string;
  readonly alias: string;
  readonly members: MentionAliasMember[];
}

interface MentionAliasRow {
  readonly id: string;
  readonly alias: string;
}

interface MentionAliasMemberRow extends MentionAliasMember {
  readonly alias_id: string;
  readonly position: number;
}

export class MentionAliasesDb extends LazyDbAccessCompatibleService {
  async findByOwner(
    ownerProfileId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<MentionAlias[]> {
    const options = connection ? { wrappedConnection: connection } : undefined;
    const aliases = await this.db.execute<MentionAliasRow>(
      `select id, alias from ${MENTION_ALIASES_TABLE}
       where owner_profile_id = :ownerProfileId
       order by normalized_alias asc`,
      { ownerProfileId },
      options
    );
    if (!aliases.length) {
      return [];
    }
    const members = await this.db.execute<MentionAliasMemberRow>(
      `select m.alias_id, m.member_profile_id as profile_id, i.handle, i.pfp, m.position
       from ${MENTION_ALIAS_MEMBERS_TABLE} m
       join ${IDENTITIES_TABLE} i on i.profile_id = m.member_profile_id
       where m.alias_id in (:aliasIds)
       order by m.alias_id asc, m.position asc`,
      { aliasIds: aliases.map((alias) => alias.id) },
      options
    );
    const membersByAlias = members.reduce<Record<string, MentionAliasMember[]>>(
      (acc, member) => {
        const aliasMembers = acc[member.alias_id] ?? [];
        aliasMembers.push({
          profile_id: member.profile_id,
          handle: member.handle,
          pfp: member.pfp
        });
        acc[member.alias_id] = aliasMembers;
        return acc;
      },
      {}
    );
    return aliases.map((alias) => ({
      ...alias,
      members: membersByAlias[alias.id] ?? []
    }));
  }

  async countByOwner(
    ownerProfileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `select count(*) as cnt from ${MENTION_ALIASES_TABLE}
         where owner_profile_id = :ownerProfileId`,
        { ownerProfileId },
        { wrappedConnection: connection }
      )
      .then((row) => row?.cnt ?? 0);
  }

  async lockOwnerProfile(
    ownerProfileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<boolean> {
    // Authentication profile IDs originate from identities.profile_id, which
    // is the same identifier stored in profiles.external_id.
    const profile = await this.db.oneOrNull<{ external_id: string }>(
      `select external_id from ${PROFILES_TABLE}
       where external_id = :ownerProfileId
       for update`,
      { ownerProfileId },
      { wrappedConnection: connection }
    );
    return profile !== null;
  }

  async findOwnedAlias(
    aliasId: string,
    ownerProfileId: string,
    connection: ConnectionWrapper<any>
  ): Promise<MentionAliasRow | null> {
    return this.db.oneOrNull<MentionAliasRow>(
      `select id, alias from ${MENTION_ALIASES_TABLE}
       where id = :aliasId and owner_profile_id = :ownerProfileId`,
      { aliasId, ownerProfileId },
      { wrappedConnection: connection }
    );
  }

  async normalizedAliasExists(
    ownerProfileId: string,
    normalizedAlias: string,
    excludedAliasId: string | null,
    connection: ConnectionWrapper<any>
  ): Promise<boolean> {
    return this.db
      .oneOrNull<{ id: string }>(
        `select id from ${MENTION_ALIASES_TABLE}
         where owner_profile_id = :ownerProfileId
           and normalized_alias = :normalizedAlias
           ${excludedAliasId ? 'and id <> :excludedAliasId' : ''}
         limit 1`,
        { ownerProfileId, normalizedAlias, excludedAliasId },
        { wrappedConnection: connection }
      )
      .then(Boolean);
  }

  async findExistingProfileIds(
    profileIds: string[],
    connection: ConnectionWrapper<any>
  ): Promise<string[]> {
    if (!profileIds.length) return [];
    return this.db
      .execute<{ profile_id: string }>(
        `select profile_id from ${IDENTITIES_TABLE}
         where profile_id in (:profileIds)`,
        { profileIds },
        { wrappedConnection: connection }
      )
      .then((rows) => rows.map((row) => row.profile_id));
  }

  async insertAlias(
    {
      id,
      ownerProfileId,
      alias,
      normalizedAlias
    }: {
      id: string;
      ownerProfileId: string;
      alias: string;
      normalizedAlias: string;
    },
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert into ${MENTION_ALIASES_TABLE}
       (id, owner_profile_id, alias, normalized_alias)
       values (:id, :ownerProfileId, :alias, :normalizedAlias)`,
      { id, ownerProfileId, alias, normalizedAlias },
      { wrappedConnection: connection }
    );
  }

  async updateAliasName(
    aliasId: string,
    alias: string,
    normalizedAlias: string,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${MENTION_ALIASES_TABLE}
       set alias = :alias, normalized_alias = :normalizedAlias
       where id = :aliasId`,
      { aliasId, alias, normalizedAlias },
      { wrappedConnection: connection }
    );
  }

  async replaceMembers(
    aliasId: string,
    memberProfileIds: string[],
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `delete from ${MENTION_ALIAS_MEMBERS_TABLE} where alias_id = :aliasId`,
      { aliasId },
      { wrappedConnection: connection }
    );
    await this.db.bulkInsert(
      MENTION_ALIAS_MEMBERS_TABLE,
      memberProfileIds.map((memberProfileId, position) => ({
        alias_id: aliasId,
        member_profile_id: memberProfileId,
        position
      })),
      ['alias_id', 'member_profile_id', 'position'],
      undefined,
      { connection }
    );
  }

  async deleteAlias(aliasId: string, connection: ConnectionWrapper<any>) {
    await this.db.execute(
      `delete from ${MENTION_ALIAS_MEMBERS_TABLE} where alias_id = :aliasId`,
      { aliasId },
      { wrappedConnection: connection }
    );
    await this.db.execute(
      `delete from ${MENTION_ALIASES_TABLE} where id = :aliasId`,
      { aliasId },
      { wrappedConnection: connection }
    );
  }

  async mergeProfileIds(
    sourceProfileId: string,
    targetProfileId: string,
    connection: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `insert ignore into ${MENTION_ALIAS_MEMBERS_TABLE}
       (alias_id, member_profile_id, position)
       select alias_id, :targetProfileId, position
       from ${MENTION_ALIAS_MEMBERS_TABLE}
       where member_profile_id = :sourceProfileId`,
      { sourceProfileId, targetProfileId },
      { wrappedConnection: connection }
    );
    await this.db.execute(
      `delete from ${MENTION_ALIAS_MEMBERS_TABLE}
       where member_profile_id = :sourceProfileId`,
      { sourceProfileId },
      { wrappedConnection: connection }
    );
    const conflictingSourceAliases = await this.db.execute<{
      source_alias_id: string;
      target_alias_id: string;
    }>(
      `select source_alias.id as source_alias_id,
              target_alias.id as target_alias_id
       from ${MENTION_ALIASES_TABLE} source_alias
       join ${MENTION_ALIASES_TABLE} target_alias
         on target_alias.owner_profile_id = :targetProfileId
        and target_alias.normalized_alias = source_alias.normalized_alias
       where source_alias.owner_profile_id = :sourceProfileId`,
      { sourceProfileId, targetProfileId },
      { wrappedConnection: connection }
    );
    for (const alias of conflictingSourceAliases) {
      const members = await this.db.execute<{
        alias_id: string;
        member_profile_id: string;
      }>(
        `select alias_id, member_profile_id
         from ${MENTION_ALIAS_MEMBERS_TABLE}
         where alias_id in (:aliasIds)
         order by case when alias_id = :targetAliasId then 0 else 1 end,
                  position asc`,
        {
          aliasIds: [alias.target_alias_id, alias.source_alias_id],
          targetAliasId: alias.target_alias_id
        },
        { wrappedConnection: connection }
      );
      const retainedMemberIds = Array.from(
        new Set(members.map((member) => member.member_profile_id))
      ).slice(0, MAX_MEMBERS_PER_MENTION_ALIAS);
      await this.replaceMembers(
        alias.target_alias_id,
        retainedMemberIds,
        connection
      );
      await this.deleteAlias(alias.source_alias_id, connection);
    }
    await this.db.execute(
      `update ${MENTION_ALIASES_TABLE}
       set owner_profile_id = :targetProfileId
       where owner_profile_id = :sourceProfileId`,
      { sourceProfileId, targetProfileId },
      { wrappedConnection: connection }
    );
  }
}

export const mentionAliasesDb = new MentionAliasesDb(dbSupplier);
