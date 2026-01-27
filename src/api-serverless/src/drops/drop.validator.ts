import * as Joi from 'joi';
import { ApiDropReferencedNFT } from '../generated/models/ApiDropReferencedNFT';
import { WALLET_REGEX } from '../../../constants';
import { DropMetadataEntity } from '../../../entities/IDrop';
import { ApiQuotedDrop } from '../generated/models/ApiQuotedDrop';
import { ApiCreateDropPart } from '../generated/models/ApiCreateDropPart';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiCreateWaveDropRequest } from '../generated/models/ApiCreateWaveDropRequest';
import { ApiReplyToDrop } from '../generated/models/ApiReplyToDrop';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiAddReactionToDropRequest } from '../generated/models/ApiAddReactionToDropRequest';

export interface ApiAddRatingToDropRequest {
  readonly rating: number;
}

export const ApiAddRatingToDropRequestSchema: Joi.ObjectSchema<ApiAddRatingToDropRequest> =
  Joi.object({
    rating: Joi.number().integer().required(),
    category: Joi.string().optional().allow(null) // for legacy reasons
  });

export const ApiAddReactionToDropRequestSchema: Joi.ObjectSchema<ApiAddReactionToDropRequest> =
  Joi.object({
    reaction: Joi.string().required()
  });

const NftSchema: Joi.ObjectSchema<ApiDropReferencedNFT> = Joi.object({
  contract: Joi.string().regex(WALLET_REGEX).lowercase(),
  token: Joi.string().regex(/^\d+$/),
  name: Joi.string().min(1)
});

const MentionedUserSchema: Joi.ObjectSchema<ApiDropReferencedNFT> = Joi.object({
  mentioned_profile_id: Joi.string().min(1).max(100).required(),
  handle_in_content: Joi.string().min(1).max(100).required()
});

const MentionedWaveSchema: Joi.ObjectSchema = Joi.object({
  wave_name_in_content: Joi.string().min(1).required(),
  wave_id: Joi.string().min(1).max(100).required()
});

const MetadataSchema: Joi.ObjectSchema<DropMetadataEntity> = Joi.object({
  data_key: Joi.string().min(1).max(100).required(),
  data_value: Joi.string().min(1).max(5000).required()
});

const QuotedDropSchema: Joi.ObjectSchema<ApiQuotedDrop> = Joi.object({
  drop_id: Joi.string().required(),
  drop_part_id: Joi.number().integer().min(1).required()
});

const NewDropPartSchema: Joi.ObjectSchema<ApiCreateDropPart> = Joi.object({
  content: Joi.string().optional().default(null).allow(null),
  quoted_drop: QuotedDropSchema.optional().default(null).allow(null),
  mentioned_waves: Joi.array()
    .optional()
    .items(MentionedWaveSchema)
    .default([]),
  media: Joi.array()
    .optional()
    .items(
      Joi.object({
        mime_type: Joi.string().required(),
        url: Joi.string().required()
      })
    )
    .default([])
});

const baseDropFieldsValidators = {
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
  mentions_all: Joi.boolean().optional(),
  signature: Joi.string().optional().allow(null).default(null),
  is_safe_signature: Joi.boolean().optional(),
  signer_address: Joi.string().optional()
};

export const NewDropSchema: Joi.ObjectSchema<ApiCreateDropRequest> = Joi.object(
  {
    ...baseDropFieldsValidators,
    reply_to: Joi.object<ApiReplyToDrop>({
      drop_id: Joi.string().required(),
      drop_part_id: Joi.number().integer().min(0)
    })
      .optional()
      .allow(null),
    wave_id: Joi.string().required(),
    drop_type: Joi.string()
      .optional()
      .default(ApiDropType.Chat)
      .valid(...[ApiDropType.Chat, ApiDropType.Participatory])
  }
);

export const UpdateDropSchema: Joi.ObjectSchema<ApiUpdateDropRequest> =
  Joi.object<ApiUpdateDropRequest>({ ...baseDropFieldsValidators });

export const NewWaveDropSchema: Joi.ObjectSchema<ApiCreateWaveDropRequest> =
  Joi.object({ ...baseDropFieldsValidators });
