import * as Joi from 'joi';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { DropReferencedNFT } from '../generated/models/DropReferencedNFT';
import { WALLET_REGEX } from '../../../constants';
import { DropMetadataEntity } from '../../../entities/IDrop';
import { QuotedDrop } from '../generated/models/QuotedDrop';
import { CreateDropPart } from '../generated/models/CreateDropPart';
import { CreateDropRequest } from '../generated/models/CreateDropRequest';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  FullPageRequest,
  PageSortDirection
} from '../page-request';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import { CreateWaveDropRequest } from '../generated/models/CreateWaveDropRequest';
import { ReplyToDrop } from '../generated/models/ReplyToDrop';

export interface DropActivityLogsQuery
  extends FullPageRequest<DropActivityLogsQuerySortOption> {
  readonly drop_id: string;
  readonly log_type?: ProfileActivityLogType;
}

export enum DropActivityLogsQuerySortOption {
  CREATED_AT = 'created_at'
}

export interface ApiAddRatingToDropRequest {
  readonly rating: number;
  readonly category: string;
}

export const ApiAddRatingToDropRequestSchema: Joi.ObjectSchema<ApiAddRatingToDropRequest> =
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

const QuotedDropSchema: Joi.ObjectSchema<QuotedDrop> = Joi.object({
  drop_id: Joi.string().required(),
  drop_part_id: Joi.number().integer().min(1).required()
});

const NewDropPartSchema: Joi.ObjectSchema<CreateDropPart> = Joi.object({
  content: Joi.string().optional().default(null).allow(null),
  quoted_drop: QuotedDropSchema.optional().default(null).allow(null),
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
});

export const NewDropSchema: Joi.ObjectSchema<CreateDropRequest> = Joi.object({
  title: Joi.string().optional().max(250).default(null).allow(null),
  parts: Joi.array().required().items(NewDropPartSchema).min(1),
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
  reply_to: Joi.object<ReplyToDrop>({
    drop_id: Joi.string().required(),
    drop_part_id: Joi.number().integer().min(0)
  })
    .optional()
    .allow(null),
  wave_id: Joi.string().required()
});

export const NewWaveDropSchema: Joi.ObjectSchema<CreateWaveDropRequest> =
  Joi.object({
    title: Joi.string().optional().max(250).default(null).allow(null),
    parts: Joi.array().required().items(NewDropPartSchema).min(1),
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
    metadata: Joi.array().optional().items(MetadataSchema).default([])
  });

export const DropDiscussionCommentsQuerySchema: Joi.ObjectSchema<DropActivityLogsQuery> =
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
