import * as Joi from 'joi';
import { ApiDropReferencedNFT } from '../generated/models/ApiDropReferencedNFT';
import { WALLET_REGEX } from '@/constants';
import { DropMetadataEntity } from '../../../entities/IDrop';
import { ApiQuotedDrop } from '../generated/models/ApiQuotedDrop';
import { ApiCreateDropPart } from '../generated/models/ApiCreateDropPart';
import { ApiCreateDropRequest } from '../generated/models/ApiCreateDropRequest';
import { ApiCreateWaveDropRequest } from '../generated/models/ApiCreateWaveDropRequest';
import { ApiReplyToDrop } from '../generated/models/ApiReplyToDrop';
import { ApiUpdateDropRequest } from '../generated/models/ApiUpdateDropRequest';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiDropRatingRequest } from '../generated/models/ApiDropRatingRequest';
import { ApiAddReactionToDropRequest } from '../generated/models/ApiAddReactionToDropRequest';
import { ApiDropGroupMention } from '../generated/models/ApiDropGroupMention';
import { ApiDropAttachmentReference } from '../generated/models/ApiDropAttachmentReference';
import { ApiCreateDropPollRequest } from '../generated/models/ApiCreateDropPollRequest';
import { Time } from '@/time';

function parseSerialNos(value: string, helpers: Joi.CustomHelpers): number[] {
  const parts = value.split(',').map((part) => part.trim());
  const serialNos = parts.map((part) => Number(part));
  if (
    parts.some((part) => !part) ||
    serialNos.some((serialNo) => !Number.isInteger(serialNo) || serialNo < 1)
  ) {
    return helpers.error('serialNos.invalid') as unknown as number[];
  }
  return Array.from(new Set(serialNos));
}

function parseDropIds(value: string, helpers: Joi.CustomHelpers): string[] {
  const dropIds = value.split(',').map((part) => part.trim());
  if (dropIds.some((dropId) => !dropId || dropId.length > 100)) {
    return helpers.error('dropIds.invalid') as unknown as string[];
  }
  return Array.from(new Set(dropIds));
}

export const SerialNosQueryParamSchema = Joi.string()
  .trim()
  .empty('')
  .custom(parseSerialNos)
  .default(null)
  .messages({
    'serialNos.invalid':
      '"serial_nos" must be a comma-separated list of positive integers'
  });

export const DropIdsQueryParamSchema = Joi.string()
  .trim()
  .empty('')
  .custom(parseDropIds)
  .default(null)
  .messages({
    'dropIds.invalid':
      '"ids" must be a comma-separated list of non-empty drop IDs'
  });

export const ApiDropRatingRequestSchema: Joi.ObjectSchema<ApiDropRatingRequest> =
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

const DROP_METADATA_VALUE_LIMITS = {
  default: 5000,
  description: 8000,
  title: 255
} as const;

function getDropMetadataValueMaxLength(dataKey: string): number {
  if (dataKey === 'title') return DROP_METADATA_VALUE_LIMITS.title;
  if (dataKey === 'description') return DROP_METADATA_VALUE_LIMITS.description;
  return DROP_METADATA_VALUE_LIMITS.default;
}

function validateDropMetadataValue(
  metadata: DropMetadataEntity,
  helpers: Joi.CustomHelpers
): DropMetadataEntity | Joi.ErrorReport {
  const maxLength = getDropMetadataValueMaxLength(metadata.data_key);
  if (metadata.data_value.length > maxLength) {
    return helpers.error('dropMetadata.dataValueMax', {
      dataKey: metadata.data_key,
      maxLength
    });
  }
  return metadata;
}

function validateFuturePollClosingTime(
  closingTime: number,
  helpers: Joi.CustomHelpers
): number | Joi.ErrorReport {
  if (closingTime <= Time.currentMillis()) {
    return helpers.error('dropPoll.closingTimeFuture');
  }
  return closingTime;
}

const MetadataSchema: Joi.ObjectSchema<DropMetadataEntity> = Joi.object({
  data_key: Joi.string().min(1).max(500).required(),
  data_value: Joi.string().min(1).required()
})
  .custom(validateDropMetadataValue)
  .messages({
    'dropMetadata.dataValueMax':
      'metadata value for "{{#dataKey}}" must be less than or equal to {{#maxLength}} characters long'
  });

const QuotedDropSchema: Joi.ObjectSchema<ApiQuotedDrop> = Joi.object({
  drop_id: Joi.string().required(),
  drop_part_id: Joi.number().integer().min(1).required()
});

const NewDropPartSchema: Joi.ObjectSchema<ApiCreateDropPart> = Joi.object({
  content: Joi.string().optional().default(null).allow(null),
  quoted_drop: QuotedDropSchema.optional().default(null).allow(null),
  media: Joi.array()
    .optional()
    .items(
      Joi.object({
        mime_type: Joi.string().required(),
        url: Joi.string().required()
      })
    )
    .default([]),
  attachments: Joi.array()
    .optional()
    .items(
      Joi.object<ApiDropAttachmentReference>({
        attachment_id: Joi.string().required()
      })
    )
    .unique('attachment_id')
    .default([])
});

const NewDropPollSchema: Joi.ObjectSchema<ApiCreateDropPollRequest> =
  Joi.object<ApiCreateDropPollRequest>({
    options: Joi.array()
      .items(Joi.string().trim().min(1).max(500))
      .min(2)
      .max(100)
      .unique()
      .required(),
    multichoice: Joi.boolean().required(),
    anonymous: Joi.boolean().optional().default(false),
    closing_time: Joi.number()
      .integer()
      .required()
      .custom(validateFuturePollClosingTime)
  }).messages({
    'dropPoll.closingTimeFuture': 'poll closing_time must be in the future'
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
  mentioned_waves: Joi.array()
    .optional()
    .items(MentionedWaveSchema)
    .default([]),
  metadata: Joi.array().optional().items(MetadataSchema).default([]),
  signature: Joi.string().optional().allow(null).default(null),
  signature_message: Joi.string().optional().allow(null).default(null),
  is_safe_signature: Joi.boolean().optional(),
  signer_address: Joi.string().optional()
};

export const NewDropSchema: Joi.ObjectSchema<ApiCreateDropRequest> = Joi.object(
  {
    ...baseDropFieldsValidators,
    mentioned_groups: Joi.array()
      .optional()
      .items(Joi.string().valid(...Object.values(ApiDropGroupMention)))
      .default([]),
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
      .valid(...[ApiDropType.Chat, ApiDropType.Participatory]),
    is_additional_action_promised: Joi.when('drop_type', {
      is: ApiDropType.Chat,
      then: Joi.forbidden(),
      otherwise: Joi.boolean().optional()
    }),
    poll: Joi.when('drop_type', {
      is: ApiDropType.Chat,
      then: NewDropPollSchema.optional(),
      otherwise: Joi.forbidden()
    })
  }
);

export const UpdateDropSchema: Joi.ObjectSchema<ApiUpdateDropRequest> =
  Joi.object<ApiUpdateDropRequest>({ ...baseDropFieldsValidators });

export const NewWaveDropSchema: Joi.ObjectSchema<ApiCreateWaveDropRequest> =
  Joi.object({ ...baseDropFieldsValidators });
