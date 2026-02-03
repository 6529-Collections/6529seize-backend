import { Request } from 'express';
import * as Joi from 'joi';
import { WALLET_REGEX } from '@/constants';
import { NotFoundException } from '../../../exceptions';
import { Timer } from '../../../time';
import {
  returnPaginatedResult,
  transformPaginatedResponse
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { identityFetcher } from '../identities/identity.fetcher';
import { cacheRequest } from '../request-cache';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  fetchConsolidatedTdhEditions,
  fetchWalletTdhEditions,
  TdhEditionFilters
} from './tdh-editions.db';

const router = asyncRouter();
export default router;

const SORT_FIELDS = [
  'id',
  'hodl_rate',
  'days_held',
  'balance',
  'edition_id',
  'contract'
] as const;

const PositiveIntSchema = Joi.number().integer().min(0);

type TdhEditionsQuery = {
  contract?: string;
  token_id?: number;
  edition_id?: number;
  sort: (typeof SORT_FIELDS)[number];
  sort_direction: 'ASC' | 'DESC';
  page: number;
  page_size: number;
};

const TdhEditionsQuerySchema: Joi.ObjectSchema<TdhEditionsQuery> = Joi.object({
  contract: Joi.string().trim().lowercase(),
  token_id: PositiveIntSchema,
  edition_id: PositiveIntSchema,
  sort: Joi.string()
    .valid(...SORT_FIELDS)
    .default('id'),
  sort_direction: Joi.string().valid('ASC', 'DESC').default('DESC'),
  page: Joi.number().integer().positive().default(1),
  page_size: Joi.number().integer().positive().max(100).default(50)
});

const WalletParamsSchema = Joi.object({
  wallet: Joi.string().pattern(WALLET_REGEX).lowercase().required()
});

const IdentityParamsSchema = Joi.object({
  identity: Joi.string().required()
});

const ConsolidationParamsSchema = Joi.object({
  consolidation_key: Joi.string().lowercase().required()
});

function mapFilters(query: TdhEditionsQuery): TdhEditionFilters {
  return {
    contract: query.contract,
    tokenId: query.token_id,
    editionId: query.edition_id
  };
}

/* ---- RESPONSE MAPPER ---- */

type TdhEditionRow = {
  contract: string;
  id: number;
  edition_id: number;
  balance: number;
  hodl_rate: number;
  days_held: number;
  wallet?: string | null;
  consolidation_key?: string | null;
};

function toApiEdition(row: TdhEditionRow, profile?: ApiProfileMin | null) {
  return {
    contract: row.contract,
    id: row.id,
    edition_id: row.edition_id,
    balance: row.balance,
    hodl_rate: row.hodl_rate,
    days_held: row.days_held,
    wallet: row.wallet ?? null,
    consolidation_key: row.consolidation_key ?? null,
    profile: profile ?? null
  };
}

/* ---- ROUTES ---- */

router.get(
  '/wallet/:wallet',
  cacheRequest(),
  async (req: Request<any, any, any, TdhEditionsQuery, any>, res: any) => {
    const { wallet } = getValidatedByJoiOrThrow(req.params, WalletParamsSchema);
    const query = getValidatedByJoiOrThrow(req.query, TdhEditionsQuerySchema);

    const result = await fetchWalletTdhEditions(
      wallet,
      query.sort,
      query.sort_direction,
      query.page,
      query.page_size,
      mapFilters(query)
    );

    const response = transformPaginatedResponse(
      (row: TdhEditionRow) => toApiEdition(row),
      result
    );
    return returnPaginatedResult(response, req, res);
  }
);

router.get(
  '/consolidation/:consolidation_key',
  cacheRequest(),
  async function (
    req: Request<any, any, any, TdhEditionsQuery, any>,
    res: any
  ) {
    const { consolidation_key } = getValidatedByJoiOrThrow(
      req.params,
      ConsolidationParamsSchema
    );
    const query = getValidatedByJoiOrThrow(req.query, TdhEditionsQuerySchema);

    const result = await fetchConsolidatedTdhEditions(
      consolidation_key,
      query.sort,
      query.sort_direction,
      query.page,
      query.page_size,
      mapFilters(query)
    );

    const response = transformPaginatedResponse(
      (row: TdhEditionRow) => toApiEdition(row),
      result
    );
    return returnPaginatedResult(response, req, res);
  }
);

router.get(
  '/identity/:identity',
  cacheRequest(),
  async (req: Request<any, any, any, TdhEditionsQuery, any>, res: any) => {
    const { identity: identityParam } = getValidatedByJoiOrThrow(
      req.params,
      IdentityParamsSchema
    );
    const query = getValidatedByJoiOrThrow(req.query, TdhEditionsQuerySchema);
    const timer = Timer.getFromRequest(req);

    const identity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: identityParam },
        { timer }
      );

    if (!identity) {
      throw new NotFoundException(`Identity ${identityParam} not found`);
    }

    const result = await fetchConsolidatedTdhEditions(
      identity.consolidation_key,
      query.sort,
      query.sort_direction,
      query.page,
      query.page_size,
      mapFilters(query)
    );

    let profile: ApiProfileMin | null = null;
    if (identity.id) {
      const profiles = await identityFetcher.getOverviewsByIds([identity.id], {
        timer
      });
      profile = profiles[identity.id] ?? null;
    }

    const response = transformPaginatedResponse(
      (row: TdhEditionRow) =>
        toApiEdition(
          { ...row, consolidation_key: identity.consolidation_key },
          profile
        ),
      result
    );

    return returnPaginatedResult(response, req, res);
  }
);
