import {
  MEME_COLLABORATIONS_TABLE,
  MEME_COLLABORATION_INVITATIONS_TABLE,
  PROFILES_TABLE
} from '@/constants';
import {
  MemeCollaborationEntity,
  MemeCollaborationInvitationEntity
} from '@/entities/IMemeCollaboration';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { LazyDbAccessCompatibleService, dbSupplier } from '@/sql-executor';

export interface CollaboratorProfile {
  id: string;
  handle: string;
  display: string;
  pfp: string | null;
}
export type CollaborationInvitation = MemeCollaborationInvitationEntity & {
  profile: CollaboratorProfile;
};

export class MemeCollaborationsDb extends LazyDbAccessCompatibleService {
  async query<T>(
    operation: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext,
    forcePool?: DbPoolName
  ): Promise<T[]> {
    const name = `${this.constructor.name}->${operation}`;
    try {
      ctx.timer?.start(name);
      return await this.db.execute<T>(
        sql,
        params,
        ctx.connection ? { wrappedConnection: ctx.connection } : { forcePool }
      );
    } finally {
      ctx.timer?.stop(name);
    }
  }

  async context(
    dropId: string,
    ctx: RequestContext,
    lock = false
  ): Promise<MemeCollaborationEntity | null> {
    if (lock && !ctx.connection)
      throw new Error('Collaboration locking requires a transaction');
    const [row] = await this.query<MemeCollaborationEntity>(
      'context',
      `select * from ${MEME_COLLABORATIONS_TABLE} where drop_id=:dropId${lock ? ' for update' : ''}`,
      { dropId },
      ctx,
      DbPoolName.WRITE
    );
    if (!row) return null;
    return {
      ...row,
      artwork:
        typeof row.artwork === 'string' ? JSON.parse(row.artwork) : row.artwork,
      credit:
        typeof row.credit === 'string' ? JSON.parse(row.credit) : row.credit
    };
  }

  async profiles(
    ids: string[],
    ctx: RequestContext
  ): Promise<CollaboratorProfile[]> {
    if (!ids.length) return [];
    return this.query(
      'profiles',
      `select external_id as id, handle, handle as display, pfp_url as pfp from ${PROFILES_TABLE} where external_id in (:ids)`,
      { ids },
      ctx
    );
  }

  async invitations(
    dropId: string,
    ctx: RequestContext
  ): Promise<CollaborationInvitation[]> {
    const rows = await this.query<MemeCollaborationInvitationEntity>(
      'invitations',
      `select * from ${MEME_COLLABORATION_INVITATIONS_TABLE} where drop_id=:dropId order by created_at asc, id asc`,
      { dropId },
      ctx,
      DbPoolName.WRITE
    );
    const profiles = new Map(
      (
        await this.profiles(
          rows.map((row) => row.profile_id),
          ctx
        )
      ).map((profile) => [profile.id, profile])
    );
    return rows.map((row) => ({
      ...row,
      profile: {
        id: row.profile_id,
        handle: profiles.get(row.profile_id)?.handle || row.profile_handle,
        display: profiles.get(row.profile_id)?.display || row.profile_handle,
        pfp: profiles.get(row.profile_id)?.pfp ?? null
      }
    }));
  }

  async acceptedByDrops(
    dropIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, CollaboratorProfile[]>> {
    if (!dropIds.length) return {};
    const rows = await this.query<CollaboratorProfile & { drop_id: string }>(
      'acceptedByDrops',
      `select i.drop_id, i.profile_id as id, coalesce(nullif(p.handle,''),i.profile_handle) as handle, coalesce(nullif(p.handle,''),i.profile_handle) as display, p.pfp_url as pfp from ${MEME_COLLABORATION_INVITATIONS_TABLE} i left join ${PROFILES_TABLE} p on p.external_id=i.profile_id where i.drop_id in (:dropIds) and i.status='ACCEPTED' order by i.created_at asc, i.id asc`,
      { dropIds },
      ctx
    );
    const result: Record<string, CollaboratorProfile[]> = {};
    for (const { drop_id, ...profile } of rows) {
      const profiles = result[drop_id] ?? [];
      profiles.push(profile);
      result[drop_id] = profiles;
    }
    return result;
  }

  async presentationByDrops(
    dropIds: string[],
    ctx: RequestContext,
    acceptedProfiles?: Record<string, CollaboratorProfile[]>
  ): Promise<
    Record<
      string,
      {
        submission_artist: string;
        credit: { artist: string; artist_profiles: string; collab: boolean };
      }
    >
  > {
    if (!dropIds.length) return {};
    const accepted =
      acceptedProfiles ?? (await this.acceptedByDrops(dropIds, ctx));
    const contexts = await this.query<
      MemeCollaborationEntity & { current_author_handle: string }
    >(
      'presentationByDrops',
      `select c.*, coalesce(nullif(p.handle,''),c.author_handle) as current_author_handle from ${MEME_COLLABORATIONS_TABLE} c left join ${PROFILES_TABLE} p on p.external_id=c.author_id where c.drop_id in (:dropIds)`,
      { dropIds },
      ctx
    );
    const result: Record<
      string,
      {
        submission_artist: string;
        credit: { artist: string; artist_profiles: string; collab: boolean };
      }
    > = {};
    for (const context of contexts) {
      const collaborators = accepted[context.drop_id] ?? [];
      const savedCredit =
        typeof context.credit === 'string'
          ? JSON.parse(context.credit)
          : context.credit;
      result[context.drop_id] = {
        submission_artist: context.base_artist,
        credit: savedCredit ?? {
          artist: [
            context.base_artist,
            ...collaborators.map((profile) => profile.display)
          ].join(', '),
          artist_profiles: [
            context.current_author_handle,
            ...collaborators.map((profile) => profile.handle)
          ]
            .filter(Boolean)
            .join(', '),
          collab: collaborators.length > 0
        }
      };
    }
    return result;
  }
}

export const memeCollaborationsDb = new MemeCollaborationsDb(dbSupplier);
