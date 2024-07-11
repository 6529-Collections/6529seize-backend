import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { dropsService } from './drops.api.service';
import { parseNumberOrNull } from '../../../helpers';
import { FullPageRequest, Page } from '../page-request';
import { Drop } from '../generated/models/Drop';
import { DropActivityLog } from '../generated/models/DropActivityLog';
import { DropComment } from '../generated/models/DropComment';
import {
  DropActivityLogsQuery,
  DropDiscussionCommentsQuerySchema
} from './drop.validator';
import {
  getDropPartQuery,
  prepLatestDropsSearchQuery,
  prepSingleDropSearchRequest
} from './drops.routes';

const router = asyncRouter();

router.get(
  '/',
  async (
    req: Request<
      any,
      any,
      any,
      {
        limit: number;
        group_id?: string;
        serial_no_less_than?: number;
        author?: string;
        min_part_id?: number;
        max_part_id?: number;
        wave_id?: string;
      },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const { limit, wave_id, group_id, min_part_id, max_part_id, author_id } =
      await prepLatestDropsSearchQuery(req);
    const latestDrops = await dropsService.findLatestDrops({
      amount: limit < 0 || limit > 20 ? 10 : limit,
      group_id: group_id,
      serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
      min_part_id,
      max_part_id,
      wave_id,
      author_id
    });
    res.send(latestDrops);
  }
);

router.get(
  '/:drop_id',
  async (
    req: Request<
      { drop_id: string },
      any,
      any,
      { min_part_id?: number; max_part_id?: number },
      any
    >,
    res: Response<ApiResponse<Drop>>
  ) => {
    const { dropId, min_part_id, max_part_id } =
      prepSingleDropSearchRequest(req);
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      min_part_id,
      max_part_id
    });
    res.send(drop);
  }
);

router.get(
  `/:drop_id/log`,
  async (
    req: Request<
      { drop_id: string },
      any,
      any,
      Omit<DropActivityLogsQuery, 'drop_id'>,
      any
    >,
    res: Response<Page<DropActivityLog>>
  ) => {
    const unvalidatedQuery: DropActivityLogsQuery = {
      drop_id: req.params.drop_id,
      ...req.query
    };
    const validatedQuery: DropActivityLogsQuery = getValidatedByJoiOrThrow(
      unvalidatedQuery,
      DropDiscussionCommentsQuerySchema
    );
    await dropsService.findDropByIdOrThrow({
      dropId: validatedQuery.drop_id,
      min_part_id: 1,
      max_part_id: 1
    });
    const discussionCommentsPage = await dropsService.findLogs(validatedQuery);
    res.send(discussionCommentsPage);
  }
);

router.get(
  `/:drop_id/parts/:drop_part_id/comments`,
  async (
    req: Request<
      { drop_id: string; drop_part_id: string },
      any,
      any,
      FullPageRequest<'created_at'>,
      any
    >,
    res: Response<Page<DropComment>>
  ) => {
    const { drop_part_id, drop_id, query } = await getDropPartQuery(req);
    const comments = await dropsService.findDropPartComments({
      ...query,
      drop_part_id,
      drop_id
    });
    res.send(comments);
  }
);

export default router;
