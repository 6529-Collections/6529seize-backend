import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { dropsService } from './drops.api.service';
import { parseNumberOrNull } from '../../../helpers';
import { FullPageRequest, Page } from '../page-request';
import { Drop } from '../generated/models/Drop';
import {
  prepDropPartQuery,
  prepLatestDropsSearchQuery,
  prepSingleDropSearchRequest
} from './drops.routes';

const router = asyncRouter();

/**
 * DEPRECATED: Use /drops instead
 */
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
        include_replies?: string;
      },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const {
      limit,
      wave_id,
      group_id,
      min_part_id,
      max_part_id,
      author_id,
      include_replies
    } = await prepLatestDropsSearchQuery(req);
    const latestDrops = await dropsService.findLatestDrops(
      {
        amount: limit < 0 || limit > 20 ? 10 : limit,
        group_id: group_id,
        serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
        min_part_id,
        max_part_id,
        wave_id,
        include_replies,
        author_id
      },
      {}
    );
    res.send(latestDrops);
  }
);

/**
 * DEPRECATED: Use /drops/:id instead
 */
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
    const drop = await dropsService.findDropByIdOrThrow(
      {
        dropId,
        min_part_id,
        max_part_id
      },
      {}
    );
    res.send(drop);
  }
);

/**
 * DEPRECATED: Use /:drop_id/parts/:drop_part_id/replies instead
 */
router.get(
  `/:drop_id/parts/:drop_part_id/replies`,
  async (
    req: Request<
      { drop_id: string; drop_part_id: string },
      any,
      any,
      FullPageRequest<'created_at'>,
      any
    >,
    res: Response<Page<Drop>>
  ) => {
    const { drop_part_id, drop_id, query } = await prepDropPartQuery(req, {});
    const replies = await dropsService.findDropReplies(
      {
        ...query,
        drop_part_id,
        drop_id
      },
      {}
    );
    res.send(replies);
  }
);

export default router;
