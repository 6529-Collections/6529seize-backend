import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { getValidatedByJoiOrThrow } from '../validation';
import { profilesService } from '../../../profiles/profiles.service';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { dropCreationService } from './drop-creation.api.service';
import { DropMetadataEntity } from '../../../entities/IDrop';
import { WALLET_REGEX } from '../../../constants';
import { dropsService } from './drops.api.service';
import { parseNumberOrNull } from '../../../helpers';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { dropRaterService } from './drop-rater.service';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  FullPageRequest,
  Page,
  PageSortDirection
} from '../page-request';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { Drop } from '../generated/models/Drop';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import { DropActivityLog } from '../generated/models/DropActivityLog';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { CommentDropRequest } from '../generated/models/CommentDropRequest';

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
        curation_criteria_id?: string;
        serial_no_less_than?: number;
        root_drop_id?: string;
        context_profile?: string;
      },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const contextProfileId = req.query.context_profile
      ? await profilesService
          .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            req.query.context_profile
          )
          ?.then((result) => result?.profile?.external_id)
      : undefined;
    const limit = parseNumberOrNull(req.query.limit) ?? 10;
    const curation_criteria_id = req.query.curation_criteria_id ?? null;
    const root_drop_id = req.query.root_drop_id ?? null;
    const latestDrops = await dropsService.findLatestDrops({
      amount: limit < 0 || limit > 20 ? 10 : limit,
      curation_criteria_id,
      serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
      root_drop_id,
      context_profile_id: contextProfileId
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
      { context_profile?: string },
      any
    >,
    res: Response<ApiResponse<Drop>>
  ) => {
    const contextProfileId = req.query.context_profile
      ? await profilesService
          .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            req.query.context_profile
          )
          ?.then((result) => result?.profile?.external_id)
      : undefined;
    const dropId = req.params.drop_id;
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      contextProfileId: contextProfileId
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
    const apiRequest = req.body;
    const newDrop: CreateDropRequest = getValidatedByJoiOrThrow(
      apiRequest,
      NewDropSchema
    );
    if (!newDrop.content && !newDrop.media.length) {
      throw new BadRequestException(
        'You need to provide either content or media'
      );
    }
    const authorProfile = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        getWalletOrThrow(req)
      )
      ?.then((result) => result?.profile ?? null);
    if (!authorProfile) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a drop'
      );
    }
    const createDropRequest: CreateDropRequest & {
      author: { external_id: string };
    } = {
      author: authorProfile,
      title: newDrop.title,
      content: newDrop.content,
      root_drop_id: newDrop.root_drop_id,
      quoted_drop_id: newDrop.quoted_drop_id,
      referenced_nfts: newDrop.referenced_nfts,
      mentioned_users: newDrop.mentioned_users,
      metadata: newDrop.metadata,
      media: newDrop.media
    };
    const createdDrop = await dropCreationService.createDrop(createDropRequest);
    res.send(createdDrop);
  }
);

router.post(
  `/:drop_id/ratings`,
  needsAuthenticatedUser(),
  async function (
    req: Request<{ drop_id: string }, any, ApiAddRatingToDropRequest, any, any>,
    res: Response<ApiResponse<Drop>>
  ) {
    const { rating, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRatingToDropRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const raterWallet = getWalletOrThrow(req);
    const raterProfileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(raterWallet)
      ?.then((result) => result?.profile?.external_id ?? null);
    if (!raterProfileId) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${raterWallet}`
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
    await dropRaterService.updateRating({
      rater_profile_id: raterProfileId,
      category: proposedCategory,
      drop_id: dropId,
      rating: rating
    });
    const drop = await dropsService.findDropByIdOrThrow({
      dropId,
      contextProfileId: raterProfileId
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
    await dropsService.findDropByIdOrThrow({ dropId: validatedQuery.drop_id });
    const discussionCommentsPage = await dropsService.findDiscussionComments(
      validatedQuery
    );
    res.send(discussionCommentsPage);
  }
);

router.post(
  `/:drop_id/log`,
  needsAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, CommentDropRequest, any, any>,
    res: Response<DropActivityLog>
  ) => {
    const authenticatedWallet = getWalletOrThrow(req);
    const authorProfileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        authenticatedWallet
      )
      ?.then((result) => result?.profile?.external_id ?? null);
    if (!authorProfileId) {
      throw new ForbiddenException(
        `Create a profile before commenting on a drop`
      );
    }
    const commentRequest: {
      drop_id: string;
      content: string;
      author_id: string;
    } = getValidatedByJoiOrThrow(
      {
        drop_id: req.params.drop_id,
        content: req.body.content,
        author_id: authorProfileId
      },
      Joi.object<{ drop_id: string; content: string; author_id: string }>({
        drop_id: Joi.string().required(),
        content: Joi.string().min(1).max(500).required(),
        author_id: Joi.string().required()
      })
    );
    await dropsService.findDropByIdOrThrow({ dropId: commentRequest.drop_id });
    const addedComment = await dropsService.commentDrop(commentRequest);
    res.send(addedComment);
  }
);

export interface DropActivityLogsQuery
  extends FullPageRequest<DropActivityLogsQuerySortOption> {
  readonly drop_id: string;
  readonly log_type?: ProfileActivityLogType;
}

export enum DropActivityLogsQuerySortOption {
  CREATED_AT = 'created_at'
}

interface ApiAddRatingToDropRequest {
  readonly rating: number;
  readonly category: string;
}

const ApiAddRatingToDropRequestSchema: Joi.ObjectSchema<ApiAddRatingToDropRequest> =
  Joi.object({
    rating: Joi.number().integer().required(),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).messages({
      'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
    })
  });

const NftSchema: Joi.ObjectSchema<DropReferencedNFT> = Joi.object({
  contract: Joi.string().regex(WALLET_REGEX).lowercase(),
  token: Joi.string().regex(/^\d+$/),
  name: Joi.string().min(1)
});

const MentionedUserSchema: Joi.ObjectSchema<DropReferencedNFT> = Joi.object({
  mentioned_profile_id: Joi.string().min(1).max(100).required(),
  handle_in_content: Joi.string().min(1).max(100).required()
});

const MetadataSchema: Joi.ObjectSchema<DropMetadataEntity> = Joi.object({
  data_key: Joi.string().min(1).max(100).required(),
  data_value: Joi.string().min(1).max(500).required()
});

const NewDropSchema: Joi.ObjectSchema<CreateDropRequest> = Joi.object({
  title: Joi.string().optional().max(250).default(null).allow(null),
  content: Joi.string().optional().max(25000).default(null).allow(null),
  quoted_drop_id: Joi.string().optional().default(null).allow(null),
  root_drop_id: Joi.string().optional().default(null).allow(null),
  referenced_nfts: Joi.array()
    .optional()
    .items(NftSchema)
    .default([])
    .allow(null),
  mentioned_users: Joi.array()
    .optional()
    .items(MentionedUserSchema)
    .default([])
    .allow(null),
  metadata: Joi.array().optional().items(MetadataSchema).default([]),
  media: Joi.array()
    .optional()
    .items(
      Joi.object({
        mime_type: Joi.string().required(),
        url: Joi.string()
          .required()
          .regex(/^https:\/\/d3lqz0a4bldqgf.cloudfront.net\//)
      })
    )
    .default([])
});

const DropDiscussionCommentsQuerySchema: Joi.ObjectSchema<DropActivityLogsQuery> =
  Joi.object({
    sort_direction: Joi.string()
      .optional()
      .default(PageSortDirection.DESC)
      .valid(...Object.values(PageSortDirection))
      .allow(null),
    sort: Joi.string()
      .optional()
      .default(DropActivityLogsQuerySortOption.CREATED_AT)
      .valid(...Object.values(DropActivityLogsQuerySortOption))
      .allow(null),
    page: Joi.number().integer().min(1).optional().allow(null).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .allow(null)
      .default(DEFAULT_PAGE_SIZE),
    drop_id: Joi.string().required(),
    log_type: Joi.string()
      .optional()
      .default(null)
      .valid(
        ...[
          ProfileActivityLogType.DROP_COMMENT,
          ProfileActivityLogType.DROP_RATING_EDIT,
          ProfileActivityLogType.DROP_CREATED
        ]
      )
  });

export default router;
