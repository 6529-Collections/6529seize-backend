import { ApiTdhGrantTargetChain } from '../generated/models/ApiTdhGrantTargetChain';
import { ApiTdhGrantStatus } from '../generated/models/ApiTdhGrantStatus';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { PageSortDirection } from '../page-request';
import * as Joi from 'joi';
import { WALLET_REGEX } from '../../../constants';
import { DEFAULT_PAGE_SIZE } from '../api-constants';

export interface TdhGrantSearchRequestApiModel {
  readonly grantor: string | null;
  readonly target_contract: string | null;
  readonly target_chain: ApiTdhGrantTargetChain | null;
  readonly status: ApiTdhGrantStatus | null;
  readonly sort_direction: PageSortDirection | null;
  readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'tdh_rate' | null;
  readonly page: number;
  readonly page_size: number;
}

export const TdhGrantSearchRequestApiModelSchema: Joi.ObjectSchema<TdhGrantSearchRequestApiModel> =
  Joi.object<TdhGrantSearchRequestApiModel>({
    grantor: Joi.string().default(null),
    target_contract: Joi.string().pattern(WALLET_REGEX).default(null),
    target_chain: Joi.string()
      .valid(...Object.values(ApiTdhGrantTargetChain))
      .default(null),
    status: Joi.string()
      .valid(...Object.values(ApiTdhGrantStatus))
      .default(null),
    sort_direction: Joi.string()
      .valid(...Object.values(ApiPageSortDirection))
      .default(null),
    sort: Joi.string()
      .valid(...['created_at', 'valid_from', 'valid_to', 'tdh_rate'])
      .default('created_at'),
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(2000)
      .default(DEFAULT_PAGE_SIZE)
  });
