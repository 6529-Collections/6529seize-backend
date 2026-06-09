import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import {
  DropPollsDb,
  DropPollsOrderBy,
  DropPollState,
  dropPollsDb
} from '@/api/drops/drop-polls.db';
import { ApiDropPollsPage } from '@/api/generated/models/ApiDropPollsPage';
import { ApiDropPollVotersPage } from '@/api/generated/models/ApiDropPollVotersPage';
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiIdentityOverview } from '@/api/generated/models/ApiIdentityOverview';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import {
  assertWaveAndParentVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveReadContextProfileId
} from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';
import { DropType } from '@/entities/IDrop';
import { DropPollOptionEntity } from '@/entities/IDropPoll';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { isWaveCreatorOrAdmin } from '@/waves/wave-admin.helpers';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { PageSortDirection } from '@/api/page-request';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { userNotifier, UserNotifier } from '@/notifications/user.notifier';

type SelectedPollOption = {
  readonly option_no: number;
  readonly option_string: string;
};

export type CreateDropPollRequest = {
  readonly options: string[];
  readonly multichoice: boolean;
  readonly closing_time: number;
};

export type FindWavePollsRequest = {
  readonly wave_id: string;
  readonly page: number;
  readonly page_size: number;
  readonly sort_direction: PageSortDirection;
  readonly sort: DropPollsOrderBy;
  readonly state: DropPollState | null;
};

export class DropPollsApiService {
  constructor(
    private readonly dropPollsDb: DropPollsDb,
    private readonly dropsDb: DropsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher,
    private readonly dropsService: DropsApiService,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly userNotifier: UserNotifier
  ) {}

  public async createPollForDrop(
    {
      poll,
      dropId,
      waveId,
      authorId,
      dropType
    }: {
      readonly poll: CreateDropPollRequest | null | undefined;
      readonly dropId: string;
      readonly waveId: string;
      readonly authorId: string;
      readonly dropType: DropType;
    },
    ctx: RequestContext
  ): Promise<void> {
    if (!poll) {
      return;
    }
    if (dropType !== DropType.CHAT) {
      throw new BadRequestException(`Polls can only be created on chat drops`);
    }
    if (poll.closing_time <= Time.currentMillis()) {
      throw new BadRequestException(`Poll closing_time must be in the future`);
    }
    const [wave, groupIdsUserIsEligibleFor] = await Promise.all([
      this.wavesApiDb.findById(waveId, ctx.connection),
      this.userGroupsService.getGroupsUserIsEligibleFor(authorId, ctx.timer)
    ]);
    if (!wave) {
      throw new BadRequestException(`Wave ${waveId} not found`);
    }
    if (
      !isWaveCreatorOrAdmin({
        authenticatedProfileId: authorId,
        wave,
        groupIdsUserIsEligibleFor
      })
    ) {
      throw new ForbiddenException(
        `Only wave creators and admins can create polls`
      );
    }
    await this.dropPollsDb.createPoll(
      {
        id: randomUUID(),
        wave_id: waveId,
        drop_id: dropId,
        closing_time: poll.closing_time,
        multichoice: poll.multichoice,
        options: poll.options.map((option, index) => ({
          option_no: index + 1,
          option_string: option.trim()
        }))
      },
      ctx
    );
  }

  public async findOptionVoters(
    {
      dropId,
      optionNo,
      page,
      pageSize
    }: {
      readonly dropId: string;
      readonly optionNo: number;
      readonly page: number;
      readonly pageSize: number;
    },
    ctx: RequestContext
  ): Promise<ApiDropPollVotersPage> {
    await this.findVisibleDropOrThrow(dropId, ctx);
    const poll = (await this.dropPollsDb.findPollsByDropIds([dropId], ctx))[
      dropId
    ];
    if (!poll) {
      throw new NotFoundException(`Drop ${dropId} does not have a poll`);
    }
    if (!poll.options.some((option) => option.option_no === optionNo)) {
      throw new NotFoundException(
        `Poll option ${optionNo} not found for drop ${dropId}`
      );
    }
    const offset = (page - 1) * pageSize;
    const [count, voterIds] = await Promise.all([
      this.dropPollsDb.countOptionVoters({ dropId, optionNo }, ctx),
      this.dropPollsDb.findOptionVoterIds(
        { dropId, optionNo, limit: pageSize, offset },
        ctx
      )
    ]);
    const votersById = voterIds.length
      ? await this.identityFetcher.getApiIdentityOverviewsByIds(voterIds, ctx)
      : {};
    return {
      count,
      page,
      next: count > page * pageSize,
      data: voterIds
        .map((voterId) => votersById[voterId])
        .filter((voter): voter is ApiIdentityOverview => voter !== undefined)
    };
  }

  public async vote(
    {
      dropId,
      voterId,
      options
    }: {
      readonly dropId: string;
      readonly voterId: string;
      readonly options: number[];
    },
    ctx: RequestContext
  ): Promise<ApiDropV2> {
    if (ctx.authenticationContext?.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to vote in polls`);
    }
    const drop = await this.findVisibleDropOrThrow(dropId, {
      ...ctx,
      authenticationContext: AuthenticationContext.fromProfileId(voterId)
    });
    const uniqueOptions = Array.from(new Set(options));
    if (uniqueOptions.length !== options.length) {
      throw new BadRequestException(`Poll options must be unique`);
    }
    if (!uniqueOptions.length) {
      throw new BadRequestException(`At least one poll option is required`);
    }
    const wave = await this.wavesApiDb.findById(drop.wave_id, ctx.connection);
    if (!wave) {
      throw new NotFoundException(`Wave ${drop.wave_id} not found`);
    }
    let selectedPollOptions: SelectedPollOption[] = [];
    let pollVoteChanged = false;
    await this.dropPollsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx = { ...ctx, connection };
        const poll = await this.dropPollsDb.findPollByDropIdForUpdate(
          dropId,
          txCtx
        );
        if (!poll) {
          throw new NotFoundException(`Drop ${dropId} does not have a poll`);
        }
        if (poll.closing_time <= Time.currentMillis()) {
          throw new BadRequestException(`Poll is closed`);
        }
        if (!poll.multichoice && uniqueOptions.length > 1) {
          throw new BadRequestException(`Poll does not allow multiple options`);
        }
        const pollOptions = await this.dropPollsDb.findOptionsByPollId(
          poll.id,
          txCtx
        );
        const validOptionNos = new Set(
          pollOptions.map((option) => option.option_no)
        );
        const invalidOption = uniqueOptions.find(
          (optionNo) => !validOptionNos.has(optionNo)
        );
        if (invalidOption !== undefined) {
          throw new BadRequestException(
            `Poll option ${invalidOption} not found`
          );
        }
        selectedPollOptions = this.getSelectedPollOptions(
          pollOptions,
          uniqueOptions
        );
        pollVoteChanged = await this.dropPollsDb.replaceVoterVotes(
          {
            pollId: poll.id,
            waveId: drop.wave_id,
            dropId,
            voterId,
            optionNos: uniqueOptions,
            voteTime: Time.currentMillis()
          },
          txCtx
        );
      }
    );
    if (pollVoteChanged) {
      await this.userNotifier.notifyOfDropPollVote(
        {
          voter_id: voterId,
          drop_id: dropId,
          drop_author_id: drop.author_id,
          poll_options: selectedPollOptions,
          wave_id: drop.wave_id
        },
        wave.visibility_group_id
      );
      await giveReadReplicaTimeToCatchUp();
      const legacyDrop = await this.dropsService.findDropByIdOrThrow(
        { dropId, skipEligibilityCheck: true },
        ctx
      );
      await this.wsListenersNotifier.notifyAboutDropUpdate(legacyDrop, ctx);
    }
    const dropsById = await this.dropsService.findDropsV2ByIds([dropId], ctx);
    const apiDrop = dropsById[dropId];
    if (!apiDrop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    return apiDrop;
  }

  private getSelectedPollOptions(
    pollOptions: DropPollOptionEntity[],
    selectedOptionNos: number[]
  ): SelectedPollOption[] {
    const selectedOptionNoSet = new Set(selectedOptionNos);
    return pollOptions
      .filter((option) => selectedOptionNoSet.has(option.option_no))
      .map((option) => ({
        option_no: option.option_no,
        option_string: option.option_string
      }));
  }

  public async findWavePolls(
    request: FindWavePollsRequest,
    ctx: RequestContext
  ): Promise<ApiDropPollsPage> {
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const wave = await this.wavesApiDb.findWaveById(
      request.wave_id,
      ctx.connection
    );
    await assertWaveAndParentVisibleOrThrow({
      wave,
      groupsUserIsEligibleFor,
      message: `Wave ${request.wave_id} not found`,
      wavesApiDb: this.wavesApiDb,
      ctx
    });
    const now = Time.currentMillis();
    const offset = (request.page - 1) * request.page_size;
    const [count, polls] = await Promise.all([
      this.dropPollsDb.countWavePolls(
        {
          waveId: request.wave_id,
          state: request.state,
          now
        },
        ctx
      ),
      this.dropPollsDb.findWavePolls(
        {
          waveId: request.wave_id,
          limit: request.page_size,
          offset,
          order: request.sort_direction,
          orderBy: request.sort,
          state: request.state,
          now
        },
        ctx
      )
    ]);
    const dropIds = polls.map((poll) => poll.drop_id);
    const dropsById = dropIds.length
      ? await this.dropsService.findDropsV2ByIds(dropIds, ctx)
      : {};
    return {
      count,
      page: request.page,
      next: count > request.page * request.page_size,
      data: dropIds
        .map((dropId) => dropsById[dropId])
        .filter((drop): drop is ApiDropV2 => drop !== undefined)
    };
  }

  private async findVisibleDropOrThrow(dropId: string, ctx: RequestContext) {
    const contextProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        contextProfileId,
        ctx.timer
      );
    const drop = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );
    if (!drop) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }
    return drop;
  }
}

export const dropPollsApiService = new DropPollsApiService(
  dropPollsDb,
  dropsDb,
  wavesApiDb,
  userGroupsService,
  identityFetcher,
  dropsService,
  wsListenersNotifier,
  userNotifier
);
