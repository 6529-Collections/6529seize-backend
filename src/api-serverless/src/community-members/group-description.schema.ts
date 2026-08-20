import * as Joi from 'joi';
import { WALLET_REGEX } from '@/constants';
import { ApiCreateGroupDescription } from '../generated/models/ApiCreateGroupDescription';
import { ApiGroupBeneficiaryGrantMatchMode } from '../generated/models/ApiGroupBeneficiaryGrantMatchMode';
import { ApiGroupCicFilter } from '../generated/models/ApiGroupCicFilter';
import { ApiGroupFilterDirection } from '../generated/models/ApiGroupFilterDirection';
import { ApiGroupLevelFilter } from '../generated/models/ApiGroupLevelFilter';
import { ApiGroupNftOwnershipMatchMode } from '../generated/models/ApiGroupNftOwnershipMatchMode';
import {
  ApiGroupOwnsNft,
  ApiGroupOwnsNftNameEnum
} from '../generated/models/ApiGroupOwnsNft';
import { ApiGroupRepFilter } from '../generated/models/ApiGroupRepFilter';
import { ApiGroupTdhFilter } from '../generated/models/ApiGroupTdhFilter';
import { ApiGroupTdhInclusionStrategy } from '../generated/models/ApiGroupTdhInclusionStrategy';

const GroupFilterDirectionSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(ApiGroupFilterDirection))
  .optional()
  .allow(null)
  .default(null);

const NullablePositiveIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .min(0)
  .optional()
  .allow(null)
  .default(null);

const NullableIntegerSchema: Joi.NumberSchema = Joi.number()
  .integer()
  .optional()
  .allow(null)
  .default(null);

const NullableStringSchema: Joi.StringSchema = Joi.string()
  .optional()
  .allow(null)
  .default(null);

const GroupTdhFilterSchema: Joi.ObjectSchema<ApiGroupTdhFilter> =
  Joi.object<ApiGroupTdhFilter>({
    min: NullablePositiveIntegerSchema,
    max: NullablePositiveIntegerSchema,
    inclusion_strategy: Joi.string()
      .allow(...Object.values(ApiGroupTdhInclusionStrategy))
      .default(ApiGroupTdhInclusionStrategy.Tdh)
  });

const GroupLevelFilterSchema: Joi.ObjectSchema<ApiGroupLevelFilter> =
  Joi.object<ApiGroupLevelFilter>({
    min: NullableIntegerSchema.min(-100).max(100),
    max: NullableIntegerSchema.min(-100).max(100)
  });

const GroupRepFilterSchema: Joi.ObjectSchema<ApiGroupRepFilter> =
  Joi.object<ApiGroupRepFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema,
    category: NullableStringSchema
  });

const GroupCicFilterSchema: Joi.ObjectSchema<ApiGroupCicFilter> =
  Joi.object<ApiGroupCicFilter>({
    min: NullableIntegerSchema,
    max: NullableIntegerSchema,
    direction: GroupFilterDirectionSchema,
    user_identity: NullableStringSchema
  });

const GroupBeneficiaryGrantMatchModeSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(ApiGroupBeneficiaryGrantMatchMode))
  .optional()
  .default(ApiGroupBeneficiaryGrantMatchMode.AnyToken);

const GroupNftOwnershipMatchModeSchema: Joi.StringSchema = Joi.string()
  .valid(...Object.values(ApiGroupNftOwnershipMatchMode))
  .optional()
  .default(ApiGroupNftOwnershipMatchMode.AllTokens);

const GroupOwnsNftSchema: Joi.ObjectSchema<ApiGroupOwnsNft> =
  Joi.object<ApiGroupOwnsNft>({
    name: Joi.string()
      .valid(...Object.values(ApiGroupOwnsNftNameEnum))
      .required(),
    tokens: Joi.array().required().items(Joi.string()).allow(null),
    match_mode: GroupNftOwnershipMatchModeSchema
  });

export const GroupDescriptionSchema: Joi.ObjectSchema<ApiCreateGroupDescription> =
  Joi.object<ApiCreateGroupDescription>({
    tdh: GroupTdhFilterSchema,
    rep: GroupRepFilterSchema,
    cic: GroupCicFilterSchema,
    level: GroupLevelFilterSchema,
    owns_nfts: Joi.array().required().items(GroupOwnsNftSchema),
    identity_addresses: Joi.array()
      .required()
      .items(Joi.string().regex(WALLET_REGEX).lowercase())
      .allow(null)
      .max(20000),
    excluded_identity_addresses: Joi.array()
      .optional()
      .items(Joi.string().regex(WALLET_REGEX).lowercase())
      .allow(null)
      .default([])
      .max(20000),
    is_beneficiary_of_grant_id: Joi.string().optional(),
    is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchModeSchema
  });

export const PreviewGroupDescriptionSchema = GroupDescriptionSchema.fork(
  [
    'tdh',
    'rep',
    'cic',
    'level',
    'owns_nfts',
    'identity_addresses',
    'excluded_identity_addresses'
  ],
  (schema) => schema.required()
).keys({
  is_beneficiary_of_grant_id: Joi.string().optional().allow(null)
});
