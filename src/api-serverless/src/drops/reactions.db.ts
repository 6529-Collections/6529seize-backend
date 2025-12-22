import { DROP_REACTIONS_TABLE } from '../../../constants';
import { RequestContext } from '../../../request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { ApiDropReaction } from '../generated/models/ApiDropReaction';
import { identityFetcher } from '../identities/identity.fetcher';

export interface DropReactionsResult {
  reactions: ApiDropReaction[];
  context_profile_reaction: string | null;
}

export class ReactionsDb extends LazyDbAccessCompatibleService {
  public async addReaction(
    profileId: string,
    dropId: string,
    waveId: string,
    reaction: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->addReaction`);
    await this.db.execute(
      `
          INSERT INTO ${DROP_REACTIONS_TABLE}
            (profile_id, drop_id, wave_id, reaction)
          VALUES
            (:profileId, :dropId, :waveId, :reaction)
          ON DUPLICATE KEY UPDATE
            reaction = VALUES(reaction),
            created_at = NOW()
        `,
      {
        profileId,
        dropId,
        waveId,
        reaction
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->addReaction`);
  }

  public async removeReaction(
    profileId: string,
    dropId: string,
    waveId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->removeReaction`);
    await this.db.execute(
      `DELETE FROM ${DROP_REACTIONS_TABLE} 
      WHERE profile_id = :profileId 
        AND drop_id = :dropId 
        AND wave_id = :waveId
      `,
      { profileId, dropId, waveId },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->removeReaction`);
  }

  public async getByDropIds(
    dropIds: string[],
    contextProfileId: string | null,
    ctx: RequestContext
  ): Promise<Map<string, DropReactionsResult>> {
    if (!dropIds.length) {
      return new Map();
    }
    ctx.timer?.start(`${this.constructor.name}->getByDropIds`);

    const rows: Array<{
      drop_id: string;
      reaction: string;
      profile_id: string;
    }> = await this.db.execute(
      `
      SELECT
        drop_id,
        reaction,
        profile_id
      FROM ${DROP_REACTIONS_TABLE} 
      WHERE drop_id IN (:dropIds)
      ORDER BY drop_id ASC, created_at DESC
      `,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );
    const profiles = await identityFetcher.getOverviewsByIds(
      Array.from(new Set(rows.map((r) => r.profile_id))),
      ctx
    );

    const result = new Map<string, DropReactionsResult>();

    for (const { drop_id, reaction, profile_id } of rows) {
      const entry = result.get(drop_id) ?? {
        reactions: [],
        context_profile_reaction: null
      };
      let bucket = entry.reactions.find((r) => r.reaction === reaction);
      if (!bucket) {
        bucket = { reaction, profiles: [] };
        entry.reactions.push(bucket);
      }
      const profile = profiles[profile_id];

      bucket.profiles.push(profile);
      result.set(drop_id, entry);
    }

    if (contextProfileId) {
      const userRows: Array<{ drop_id: string; reaction: string }> =
        await this.db.execute(
          `
          SELECT drop_id, reaction
          FROM ${DROP_REACTIONS_TABLE}
          WHERE profile_id = :profileId
            AND drop_id IN (:dropIds)
          `,
          { profileId: contextProfileId, dropIds },
          { wrappedConnection: ctx.connection }
        );

      for (const { drop_id, reaction } of userRows) {
        const entry = result.get(drop_id);
        if (entry) {
          entry.context_profile_reaction = reaction;
        }
      }
    }

    ctx.timer?.stop(`${this.constructor.name}->getByDropIds`);

    return result;
  }

  public async deleteReactionsByDrop(dropId: string, ctx: RequestContext) {
    await this.db.execute(
      `DELETE FROM ${DROP_REACTIONS_TABLE} WHERE drop_id = :dropId`,
      { dropId },
      { wrappedConnection: ctx.connection }
    );
  }

  public async deleteReactionsByWave(waveId: string, ctx: RequestContext) {
    await this.db.execute(
      `DELETE FROM ${DROP_REACTIONS_TABLE} WHERE wave_id = :waveId`,
      { waveId },
      { wrappedConnection: ctx.connection }
    );
  }

  public async mergeOnProfileIdChange(
    {
      previous_id,
      new_id
    }: {
      previous_id: string;
      new_id: string;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->mergeOnProfileIdChange`);
    await this.db.execute(
      `
        delete old_reactions
        from ${DROP_REACTIONS_TABLE} old_reactions
        inner join ${DROP_REACTIONS_TABLE} new_reactions
          on old_reactions.wave_id = new_reactions.wave_id
          and old_reactions.drop_id = new_reactions.drop_id
        where old_reactions.profile_id = :previous_id
          and new_reactions.profile_id = :new_id
      `,
      { previous_id, new_id },
      { wrappedConnection: ctx.connection }
    );
    await this.db.execute(
      `
        update ${DROP_REACTIONS_TABLE} 
        set profile_id = :new_id
        where profile_id = :previous_id
      `,
      { previous_id, new_id },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->mergeOnProfileIdChange`);
  }
}

export const reactionsDb = new ReactionsDb(dbSupplier);
