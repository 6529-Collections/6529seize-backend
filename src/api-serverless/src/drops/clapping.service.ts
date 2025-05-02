import { RequestContext } from '../../../request.context';
import { clappingDb, ClappingDb } from './clapping.db';
import { Time, Timer } from '../../../time';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { DropType } from '../../../entities/IDrop';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';
import { ConnectionWrapper } from '../../../sql-executor';
import { seizeSettings } from '../api-constants';
import {
  IdentitySubscriptionsDb,
  identitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';

export class ClappingService {
  constructor(
    private readonly clappingDb: ClappingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly userNotifier: UserNotifier,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async clap(
    {
      clapper_id,
      drop_id,
      wave_id,
      claps,
      proxy_id
    }: {
      clapper_id: string;
      drop_id: string;
      wave_id: string;
      claps: number;
      proxy_id: string | null;
    },
    ctx: RequestContext
  ) {
    if (!ctx.connection) {
      await this.clappingDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.clap(
            { clapper_id, drop_id, wave_id, claps, proxy_id },
            { ...ctx, connection }
          );
        }
      );
      return;
    }
    const now = Time.now();
    const [
      drop,
      groupsClapperIsEligibleFor,
      wave,
      currentClaps,
      creditSpentBeforeThisClapping,
      clapperTdh
    ] = await Promise.all([
      this.dropsDb.findDropById(drop_id, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(clapper_id, ctx.timer),
      this.wavesDb.findById(wave_id, ctx.connection),
      this.clappingDb.getCurrentState(
        { clapperId: clapper_id, drop_id: drop_id },
        ctx
      ),
      this.clappingDb.getCreditSpentInTimespan(
        {
          timeSpanStart: now.minusDays(30),
          timeSpanEnd: now,
          clapperId: clapper_id
        },
        ctx
      ),
      this.identitiesDb
        .getIdentityByProfileId(clapper_id, ctx.connection)
        ?.then((identity) => identity?.tdh ?? 0)
    ]);

    if (!drop || drop.wave_id !== wave_id) {
      throw new BadRequestException('Drop not found');
    }
    if (!wave) {
      throw new BadRequestException('Wave not found');
    }
    if (drop.drop_type !== DropType.CHAT) {
      throw new BadRequestException(`You can't clap on a non chat drop`);
    }
    if (
      wave.chat_group_id !== null &&
      !groupsClapperIsEligibleFor.includes(wave.chat_group_id)
    ) {
      throw new ForbiddenException(
        'Clapper is not eligible to chat or clap in this wave'
      );
    }
    if (!wave.chat_enabled) {
      throw new ForbiddenException(
        'Chatting and clapping is not enabled in this wave'
      );
    }
    const creditSpentWithCurrentClaps = Math.abs(claps - currentClaps);

    if (
      creditSpentWithCurrentClaps + creditSpentBeforeThisClapping >
      clapperTdh
    ) {
      throw new BadRequestException('Not enough credit to clap');
    }
    await Promise.all([
      this.clappingDb.upsertState(
        {
          clapper_id: clapper_id,
          drop_id: drop_id,
          claps,
          wave_id: wave_id
        },
        ctx
      ),
      this.clappingDb.insertCreditSpending(
        {
          clapper_id: clapper_id,
          drop_id: drop_id,
          credit_spent: creditSpentWithCurrentClaps,
          created_at: now.toMillis(),
          wave_id: wave_id
        },
        ctx
      ),
      profileActivityLogsDb.insert(
        {
          profile_id: clapper_id,
          type: ProfileActivityLogType.DROP_CLAPPED,
          target_id: drop_id,
          contents: JSON.stringify({
            oldClaps: currentClaps,
            newClaps: claps
          }),
          additional_data_1: drop.author_id,
          additional_data_2: drop.wave_id,
          proxy_id: proxy_id
        },
        ctx.connection,
        ctx.timer
      ),
      (() =>
        drop.author_id === clapper_id
          ? Promise.resolve()
          : this.userNotifier.notifyOfDropVote(
              {
                voter_id: clapper_id,
                drop_id: drop_id,
                drop_author_id: drop.author_id,
                vote: claps,
                wave_id: wave_id
              },
              wave.visibility_group_id,
              ctx.connection
            ))(),
      this.recordAllNotificationsSubscribers(
        {
          waveId: wave_id,
          dropId: drop_id,
          clapperId: clapper_id,
          vote: {
            rating: claps,
            drop_author_id: drop.author_id
          }
        },
        { timer: ctx.timer, connection: ctx.connection }
      )
    ]);
  }

  async findCreditLeftForClapping(profileId: string): Promise<number> {
    const now = Time.now();
    const [creditSpent, tdh] = await Promise.all([
      this.clappingDb.getCreditSpentInTimespan(
        {
          timeSpanStart: now.minusDays(30),
          timeSpanEnd: now,
          clapperId: profileId
        },
        {}
      ),
      this.identitiesDb
        .getIdentityByProfileId(profileId)
        ?.then((identity) => identity?.tdh ?? 0)
    ]);
    return tdh - creditSpent;
  }

  public async deleteClaps(dropId: string, ctx: RequestContext) {
    await Promise.all([
      this.clappingDb.deleteForDrop(dropId, ctx),
      this.clappingDb.deleteCreditSpendings(dropId, ctx)
    ]);
  }

  async deleteClapsByWave(waveId: string, ctx: RequestContext) {
    await Promise.all([
      this.clappingDb.deleteForWave(waveId, ctx),
      this.clappingDb.deleteCreditSpendingsForWave(waveId, ctx)
    ]);
  }

  private async recordAllNotificationsSubscribers(
    {
      waveId,
      dropId,
      clapperId,
      vote
    }: {
      waveId: string;
      dropId: string;
      clapperId: string;
      vote: {
        rating: number;
        drop_author_id: string;
      };
    },
    { timer, connection }: { timer?: Timer; connection: ConnectionWrapper<any> }
  ) {
    const subscriberIds =
      await this.identitySubscriptionsDb.findWaveSubscribedAllSubscribers(
        waveId,
        connection
      );
    if (
      subscriberIds.length >
      seizeSettings().all_drops_notifications_subscribers_limit
    ) {
      return;
    }
  }
}

export const clappingService = new ClappingService(
  clappingDb,
  identitiesDb,
  wavesApiDb,
  dropsDb,
  userGroupsService,
  userNotifier,
  profileActivityLogsDb,
  identitySubscriptionsDb
);
