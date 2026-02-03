import { ApiPageSortDirection } from '../../generated/models/ApiPageSortDirection';
import { PageSortDirection } from '../../page-request';
import * as Joi from 'joi';
import { WALLET_REGEX } from '@/constants';
import { DEFAULT_PAGE_SIZE } from '../../api-constants';
import { ApiXTdhGrantTargetChain } from '../../generated/models/ApiXTdhGrantTargetChain';
import { ApiXTdhGrantUpdateRequest } from '../../generated/models/ApiXTdhGrantUpdateRequest';

export interface XTdhGrantSearchRequestApiModel {
  readonly grantor: string | null;
  readonly target_contract: string | null;
  readonly target_collection_name: string | null;
  readonly target_chain: ApiXTdhGrantTargetChain | null;
  readonly valid_from_lt: number | null;
  readonly valid_from_gt: number | null;
  readonly valid_to_lt: number | null;
  readonly valid_to_gt: number | null;
  readonly status?: string | null;
  readonly sort_direction: PageSortDirection | null;
  readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'rate' | null;
  readonly page: number;
  readonly page_size: number;
}

export interface XTdhGrantTokensSearchRequestApiModel {
  readonly grant_id: string;
  readonly sort_direction: PageSortDirection;
  readonly sort: 'token';
  readonly page: number;
  readonly page_size: number;
}

export const XTdhGrantSearchRequestApiModelSchema: Joi.ObjectSchema<XTdhGrantSearchRequestApiModel> =
  Joi.object<XTdhGrantSearchRequestApiModel>({
    grantor: Joi.string().default(null),
    target_contract: Joi.string().pattern(WALLET_REGEX).default(null),
    target_collection_name: Joi.string().optional().default(null),
    target_chain: Joi.string()
      .valid(...Object.values(ApiXTdhGrantTargetChain))
      .default(null),
    valid_from_lt: Joi.number().integer().positive().optional().default(null),
    valid_from_gt: Joi.number().integer().positive().optional().default(null),
    valid_to_lt: Joi.number().integer().positive().optional().default(null),
    valid_to_gt: Joi.number().integer().positive().optional().default(null),
    status: Joi.string(),
    sort_direction: Joi.string()
      .valid(...Object.values(ApiPageSortDirection))
      .default(null),
    sort: Joi.string()
      .optional()
      .valid(...['created_at', 'valid_from', 'valid_to', 'rate'])
      .default('created_at'),
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(2000)
      .default(DEFAULT_PAGE_SIZE)
  });

export const XTdhGrantTokensSearchRequestApiModelSchema: Joi.ObjectSchema<XTdhGrantTokensSearchRequestApiModel> =
  Joi.object<XTdhGrantTokensSearchRequestApiModel>({
    grant_id: Joi.string().required(),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .default(PageSortDirection.ASC),
    sort: Joi.string()
      .optional()
      .valid(...['token'])
      .default('token'),
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(2000)
      .default(DEFAULT_PAGE_SIZE)
  });

export const ApiXTdhGrantUpdateRequestSchema: Joi.ObjectSchema<ApiXTdhGrantUpdateRequest> =
  Joi.object<ApiXTdhGrantUpdateRequest>({
    valid_to: Joi.number().optional().allow(null).integer().positive()
  });
