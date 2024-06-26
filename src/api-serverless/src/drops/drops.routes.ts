import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { dropCreationService } from './drop-creation.api.service';
import { dropsService } from './drops.api.service';
import { parseIntOrNull, parseNumberOrNull } from '../../../helpers';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { dropRaterService } from './drop-rater.service';
import { FullPageRequest, Page, PageSortDirection } from '../page-request';
import { Drop } from '../generated/models/Drop';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { DropActivityLog } from '../generated/models/DropActivityLog';
import { NewDropComment } from '../generated/models/NewDropComment';
import { DropComment } from '../generated/models/DropComment';
import { userGroupsService } from '../community-members/user-groups.service';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  ApiAddRatingToDropRequest,
  ApiAddRatingToDropRequestSchema,
  DropActivityLogsQuery,
  DropDiscussionCommentsQuerySchema,
  NewDropSchema
} from './drop.validator';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      any,
      {
        limit: number;
        group_id?: string;
        serial_no_less_than?: number;
        min_part_id?: number;
        max_part_id?: number;
        wave_id?: string;
      },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const limit = parseNumberOrNull(req.query.limit) ?? 10;
    const wave_id = req.query.wave_id ?? null;
    const group_id = req.query.group_id ?? null;
    let min_part_id = parseIntOrNull(req.query.min_part_id);
    if (!min_part_id || min_part_id < 1) {
      min_part_id = 0;
    }
    let max_part_id = parseIntOrNull(req.query.max_part_id);
    if (!max_part_id || max_part_id < 1) {
      max_part_id = Number.MAX_SAFE_INTEGER;
    }
    if (max_part_id < min_part_id) {
      throw new BadRequestException(
        'max_part_id must be greater or equal than min_part_id'
      );
    }
    const latestDrops = await dropsService.findLatestDrops({
      amount: limit < 0 || limit > 20 ? 10 : limit,
      group_id: group_id,
      serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
      min_part_id,
      max_part_id,
      wave_id,
      authenticationContext
    });
    res.send(latestDrops);
  }
);

router.get(
  '/:drop_id',
  needsAuthenticatedUser(),
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
    const authenticationContext = await getAuthenticationContext(req);
    const dropId = req.params.drop_id;
    let min_part_id = parseIntOrNull(req.query.min_part_id);
    if (!min_part_id || min_part_id < 1) {
      min_part_id = 0;
    }
    let max_part_id = parseIntOrNull(req.query.max_part_id);
    if (!max_part_id || max_part_id < 1) {
      max_part_id = Number.MAX_SAFE_INTEGER;
    }
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id,
      max_part_id
    });
    res.send(drop);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateDropRequest, any, any>,
    res: Response<ApiResponse<Drop>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authorProfileId = authenticationContext.getActingAsId();
    if (!authorProfileId) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a drop'
      );
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to create drops`
      );
    }
    const apiRequest = req.body;
    const newDrop: CreateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      NewDropSchema
    );
    const invalidPart = newDrop.parts.find(
      (part) =>
        (part.content?.trim()?.length ?? 0) === 0 && part.media.length === 0
    );
    if (invalidPart) {
      throw new BadRequestException(
        'Each drop part must have content or media attached'
      );
    }
    const contentLength = newDrop.parts
      .map((part) => part.content ?? '')
      .join('').length;
    if (contentLength > 25000) {
      throw new BadRequestException(
        'Total content length of all parts must be less than 25000 characters'
      );
    }
    const createDropRequest: CreateDropRequest & {
      author: { external_id: string };
    } = {
      author: { external_id: authorProfileId },
      title: newDrop.title,
      parts: newDrop.parts,
      referenced_nfts: newDrop.referenced_nfts,
      mentioned_users: newDrop.mentioned_users,
      metadata: newDrop.metadata,
      wave_id: newDrop.wave_id
    };
    const createdDrop = await dropCreationService.createDrop(
      createDropRequest,
      authenticationContext
    );
    res.send(createdDrop);
  }
);

router.post(
  `/:drop_id/ratings`,
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, ApiAddRatingToDropRequest, any, any>,
    res: Response<ApiResponse<Drop>>
  ) => {
    const { rating, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRatingToDropRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const authenticationContext = await getAuthenticationContext(req);
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${authenticationContext.authenticatedWallet}`
      );
    }
    const dropId = req.params.drop_id;
    if (proposedCategory !== '') {
      const abusivenessDetectionResult =
        await abusivenessCheckService.checkRepPhrase(category);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(
          abusivenessDetectionResult.explanation ??
            'Given category is not allowed'
        );
      }
    }
    const raterProfileId = authenticationContext.getActingAsId()!;
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ApiProfileProxyActionType.RATE_WAVE_DROP
      ]
    ) {
      throw new ForbiddenException(
        `Proxy doesn't have permission to rate drops`
      );
    }
    const group_ids_user_is_eligible_for =
      await userGroupsService.getGroupsUserIsEligibleFor(raterProfileId);
    await dropRaterService.updateRating({
      rater_profile_id: raterProfileId,
      groupIdsUserIsEligibleFor: group_ids_user_is_eligible_for,
      category: proposedCategory,
      drop_id: dropId,
      rating: rating
    });
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      authenticationContext,
      min_part_id: 1,
      max_part_id: 1
    });
    res.send(drop);
  }
);

router.get(
  `/:drop_id/log`,
  needsAuthenticatedUser(),
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
    const authenticationContext = await getAuthenticationContext(req);
    await dropsService.findDropByIdOrThrow({
      authenticationContext,
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
  needsAuthenticatedUser(),
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
    const drop_part_id = parseIntOrNull(req.params.drop_part_id);
    const drop_id = req.params.drop_id;
    if (drop_part_id === null) {
      throw new NotFoundException(
        `Drop part ${drop_id}/${req.params.drop_part_id} not found`
      );
    }
    const authenticationContext = await getAuthenticationContext(req);
    await dropsService
      .findDropByIdOrThrow({
        authenticationContext,
        dropId: drop_id,
        min_part_id: drop_part_id,
        max_part_id: drop_part_id
      })
      .then((drop) => {
        if (drop.parts.length === 0) {
          throw new NotFoundException(
            `Drop part ${drop_id}/${req.params.drop_part_id} not found`
          );
        }
      });
    const query = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<FullPageRequest<'created_at'>>({
        sort_direction: Joi.string()
          .optional()
          .default(PageSortDirection.DESC)
          .valid(...Object.values(PageSortDirection)),
        sort: Joi.string().optional().default('created_at').valid('created_at'),
        page: Joi.number().integer().min(1).optional().default(1),
        page_size: Joi.number().integer().min(1).max(50).optional().default(20)
      })
    );
    const comments = await dropsService.findDropPartComments({
      ...query,
      drop_part_id,
      drop_id
    });
    res.send(comments);
  }
);

router.post(
  `/:drop_id/parts/:drop_part_id/comments`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { drop_id: string; drop_part_id: string },
      any,
      NewDropComment,
      any,
      any
    >,
    res: Response<DropComment>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't comment on drops.`);
    }
    const drop_part_id = parseIntOrNull(req.params.drop_part_id);
    if (drop_part_id === null) {
      throw new NotFoundException(
        `Drop part ${req.params.drop_id}/${req.params.drop_part_id} not found`
      );
    }
    if (!authenticationContext.getActingAsId()) {
      throw new ForbiddenException(
        `Create a profile before commenting on a drop`
      );
    }
    const commentRequest = getValidatedByJoiOrThrow(
      {
        drop_part_id,
        drop_id: req.params.drop_id,
        comment: req.body.comment,
        author_id: authenticationContext.getActingAsId()!
      },
      Joi.object<{
        drop_id: string;
        comment: string;
        author_id: string;
        drop_part_id: number;
      }>({
        drop_part_id: Joi.number().integer().min(1).required(),
        drop_id: Joi.string().required(),
        comment: Joi.string().min(1).max(2000).required(),
        author_id: Joi.string().required()
      })
    );
    await dropsService
      .findDropByIdOrThrow({
        authenticationContext,
        dropId: commentRequest.drop_id,
        min_part_id: drop_part_id,
        max_part_id: drop_part_id
      })
      .then((drop) => {
        if (drop.parts.length === 0) {
          throw new NotFoundException(
            `Drop part ${commentRequest.drop_id}/${commentRequest.drop_part_id} not found`
          );
        }
      });
    const addedComment = await dropsService.commentDrop(commentRequest);
    res.send(addedComment);
  }
);

export default router;
