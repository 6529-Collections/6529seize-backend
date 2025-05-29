import { RequestContext } from '../../../../request.context';
import {
  BadRequestException,
  ForbiddenException
} from '../../../../exceptions';
import { wavesApiDb, WavesApiDb } from '../../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../../community-members/user-groups.service';
import { ProfileActivityLogType } from '../../../../entities/IProfileActivityLog';
import { NewDropReaction, reactionsDb, ReactionsDb } from './reactions.db';
import { dropsDb, DropsDb } from '../../../../drops/drops.db';
import { profileActivityLogsDb } from '../../../../profileActivityLogs/profile-activity-logs.db';
import {
  UserNotifier,
  userNotifier
} from '../../../../notifications/user.notifier';

export class ReactionsService {
  constructor(
    private readonly reactionsDb: ReactionsDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier
  ) {}

  public async react(reaction: NewDropReaction, ctx: RequestContext) {
    if (!ctx.connection) {
      await this.reactionsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.react(reaction, { ...ctx, connection });
        }
      );
      return;
    }

    ctx.timer?.start(`${this.constructor.name}->react`);
    const [drop, groupsUserIsEligibleFor, wave] = await Promise.all([
      this.dropsDb.findDropById(reaction.dropId, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(
        reaction.profileId,
        ctx.timer
      ),
      this.wavesDb.findById(reaction.waveId, ctx.connection)
    ]);

    if (!drop || drop.wave_id !== reaction.waveId) {
      throw new BadRequestException('Drop not found');
    }
    if (!wave) {
      throw new BadRequestException('Wave not found');
    }
    if (
      wave.chat_group_id !== null &&
      !groupsUserIsEligibleFor.includes(wave.chat_group_id)
    ) {
      throw new ForbiddenException(
        'User is not eligible to react in this wave'
      );
    }
    if (!wave.chat_enabled) {
      throw new ForbiddenException(
        'Chatting and reacting is not enabled in this wave'
      );
    }

    await Promise.all([
      this.reactionsDb.upsertState(reaction, ctx),
      profileActivityLogsDb.insert(
        {
          profile_id: reaction.profileId,
          type: ProfileActivityLogType.DROP_REACTED,
          target_id: reaction.dropId,
          contents: JSON.stringify({
            reaction
          }),
          additional_data_1: drop.author_id,
          additional_data_2: drop.wave_id,
          proxy_id: null // TODO: DO WE NEED THIS?
        },
        ctx.connection,
        ctx.timer
      ),
      (() =>
        drop.author_id === reaction.profileId || reaction.isDeleting
          ? Promise.resolve()
          : this.userNotifier.notifyOfDropReaction(
              {
                profile_id: reaction.profileId,
                drop_id: reaction.dropId,
                drop_author_id: drop.author_id,
                reaction: reaction.reaction,
                wave_id: reaction.waveId
              },
              wave.visibility_group_id,
              ctx.connection
            ))()
    ]);
    ctx.timer?.stop(`${this.constructor.name}->react`);
  }
}

export const reactionsService = new ReactionsService(
  reactionsDb,
  wavesApiDb,
  dropsDb,
  userGroupsService,
  userNotifier
);
