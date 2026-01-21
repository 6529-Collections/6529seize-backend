import { dropBookmarksDb, DropBookmarksDb } from './drop-bookmarks.db';
import { dropsDb, DropsDb } from '../../../drops/drops.db';
import { dropsMappers, DropsMappers } from './drops.mappers';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { RequestContext } from '../../../request.context';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiDropsPage } from '../generated/models/ApiDropsPage';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

export class DropBookmarksApiService {
  constructor(
    private readonly dropBookmarksDb: DropBookmarksDb,
    private readonly dropsDb: DropsDb,
    private readonly dropsMappers: DropsMappers,
    private readonly userGroupsService: UserGroupsService
  ) {}

  async bookmarkDrop(dropId: string, ctx: RequestContext): Promise<ApiDrop> {
    const identityId = ctx.authenticationContext?.getActingAsId();
    if (!identityId) {
      throw new ForbiddenException(
        'You need to create a profile before you can bookmark drops'
      );
    }

    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        identityId,
        ctx.timer
      );

    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );

    if (!dropEntity) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }

    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.dropBookmarksDb.insertBookmark(
          { identity_id: identityId, drop_id: dropId },
          connection
        );
        await giveReadReplicaTimeToCatchUp();
        const drops = await this.dropsMappers.convertToDropFulls(
          {
            dropEntities: [dropEntity],
            contextProfileId: identityId
          },
          connection
        );
        return drops[0];
      }
    );
  }

  async unbookmarkDrop(dropId: string, ctx: RequestContext): Promise<ApiDrop> {
    const identityId = ctx.authenticationContext?.getActingAsId();
    if (!identityId) {
      throw new ForbiddenException(
        'You need to create a profile before you can unbookmark drops'
      );
    }

    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        identityId,
        ctx.timer
      );

    const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
      dropId,
      groupIdsUserIsEligibleFor,
      ctx.connection
    );

    if (!dropEntity) {
      throw new NotFoundException(`Drop ${dropId} not found`);
    }

    return await this.dropsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.dropBookmarksDb.deleteBookmark(
          { identity_id: identityId, drop_id: dropId },
          connection
        );
        await giveReadReplicaTimeToCatchUp();
        const drops = await this.dropsMappers.convertToDropFulls(
          {
            dropEntities: [dropEntity],
            contextProfileId: identityId
          },
          connection
        );
        return drops[0];
      }
    );
  }

  async getBookmarkedDrops(
    params: {
      wave_id: string | null;
      page_size: number;
      page: number;
      sort_direction: ApiPageSortDirection;
    },
    ctx: RequestContext
  ): Promise<ApiDropsPage> {
    const identityId = ctx.authenticationContext?.getActingAsId();
    if (!identityId) {
      throw new ForbiddenException(
        'You need to create a profile before you can view bookmarked drops'
      );
    }

    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        identityId,
        ctx.timer
      );

    const { drop_ids, count } =
      await this.dropBookmarksDb.findBookmarkedDropsForIdentity(
        {
          identity_id: identityId,
          wave_id: params.wave_id,
          page_size: params.page_size,
          page: params.page,
          sort_direction:
            params.sort_direction === ApiPageSortDirection.Asc ? 'ASC' : 'DESC',
          group_ids_user_is_eligible_for: groupIdsUserIsEligibleFor
        },
        ctx.connection
      );

    if (drop_ids.length === 0) {
      return {
        data: [],
        count,
        page: params.page,
        next: false
      };
    }

    const dropEntities = await this.dropsDb.getDropsByIds(
      drop_ids,
      ctx.connection
    );

    const orderedDropEntities = drop_ids
      .map((id) => dropEntities.find((e) => e.id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined);

    const drops = await this.dropsMappers.convertToDropFulls(
      {
        dropEntities: orderedDropEntities,
        contextProfileId: identityId
      },
      ctx.connection
    );

    const orderedDrops = drop_ids
      .map((id) => drops.find((d) => d.id === id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    return {
      data: orderedDrops,
      count,
      page: params.page,
      next: count > params.page_size * params.page
    };
  }
}

export const dropBookmarksApiService = new DropBookmarksApiService(
  dropBookmarksDb,
  dropsDb,
  dropsMappers,
  userGroupsService
);
