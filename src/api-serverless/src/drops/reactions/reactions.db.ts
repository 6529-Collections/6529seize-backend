import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../../sql-executor';
import { RequestContext } from '../../../../request.context';
import { DROP_REACTIONS_TABLE, IDENTITIES_TABLE } from '../../../../constants';
import { BadRequestException } from '../../../../exceptions';
import { ApiDropReaction } from '../../generated/models/ApiDropReaction';

export interface NewDropReaction {
  profileId: string;
  dropId: string;
  waveId: string;
  reaction: string;
  isDeleting: boolean;
}

export interface DropReactionsResult {
  reactions: ApiDropReaction[];
  context_profile_reaction: string | null;
}

export class ReactionsDb extends LazyDbAccessCompatibleService {
  public async upsertState(payload: NewDropReaction, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->upsertState`);
    const {
      profileId,
      dropId,
      waveId,
      reaction: reactionStr,
      isDeleting
    } = payload;

    if (isDeleting) {
      // ----- DELETE PATH -----
      await this.db.execute(
        `
          DELETE FROM ${DROP_REACTIONS_TABLE}
          WHERE profile_id = :profileId
            AND drop_id    = :dropId
            AND wave_id    = :waveId
            AND reaction   = :reaction
        `,
        { profileId, dropId, waveId, reaction: reactionStr },
        { wrappedConnection: ctx.connection }
      );
    } else {
      // ----- INSERT/UPDATE PATH -----
      await this.db.execute(
        `
          INSERT INTO ${DROP_REACTIONS_TABLE}
            (profile_id, drop_id, wave_id, reaction)
          VALUES
            (:profileId, :dropId, :waveId, :reaction)
          ON DUPLICATE KEY UPDATE
            reaction = VALUES(reaction)
        `,
        {
          profileId,
          dropId,
          waveId,
          reaction: reactionStr
        },
        { wrappedConnection: ctx.connection }
      );
    }
    ctx.timer?.stop(`${this.constructor.name}->upsertState`);
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

    // 1) Fetch all reactions + full profile object for each drop
    const rows: Array<{
      drop_id: string;
      reaction: string;
      profile_id: string;
      handle: string;
      pfp: string;
    }> = await this.db.execute(
      `
      SELECT
        dr.drop_id       AS drop_id,
        dr.reaction      AS reaction,
        i.profile_id     AS profile_id,
        i.handle         AS handle,
        i.pfp            AS pfp
      FROM ${DROP_REACTIONS_TABLE} dr
      JOIN ${IDENTITIES_TABLE}    i
        ON dr.profile_id = i.profile_id
      WHERE dr.drop_id IN (:dropIds)
      `,
      { dropIds },
      { wrappedConnection: ctx.connection }
    );

    // 2) Build an empty result map for every dropId
    const result = new Map<string, DropReactionsResult>();

    // 3) Group rows into result.get(drop_id).reactions
    for (const { drop_id, reaction, profile_id, handle, pfp } of rows) {
      const entry = result.get(drop_id) ?? {
        reactions: [],
        context_profile_reaction: null
      };
      let bucket = entry.reactions.find((r) => r.reaction === reaction);
      if (!bucket) {
        bucket = { reaction, profiles: [] };
        entry.reactions.push(bucket);
      }
      bucket.profiles.push({
        id: profile_id,
        handle: !handle || handle === 'null' ? null : handle,
        pfp: !pfp || pfp === 'null' ? null : pfp
      });
      result.set(drop_id, entry);
    }

    // 4) Fetch context‐user’s reaction for all drops in one go
    if (contextProfileId) {
      const userRows: Array<{ drop_id: string; reaction: string }> =
        await this.db.execute(
          `
          SELECT drop_id, reaction
          FROM ${DROP_REACTIONS_TABLE}
          WHERE profile_id = :profileId
            AND drop_id    IN (:dropIds)
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
}

export const reactionsDb = new ReactionsDb(dbSupplier);
