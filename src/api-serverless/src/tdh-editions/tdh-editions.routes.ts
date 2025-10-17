import * as Joi from 'joi';
import { WALLET_REGEX } from '../../../constants';
import { NotFoundException } from '../../../exceptions';
import { identityFetcher } from '../identities/identity.fetcher';
import { getValidatedByJoiOrThrow } from '../validation';
import { Timer } from '../../../time';
import {
  returnPaginatedResult,
  transformPaginatedResponse
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import {
  DEFAULT_TDH_EDITION_SORT,
  TdhEditionFilters,
  fetchConsolidatedTdhEditions,
  fetchWalletTdhEditions,
  TDH_EDITION_SORT_MAP
} from './tdh-editions.db';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';

const router = asyncRouter();

export default router;

const SORT_FIELDS = Object.keys(TDH_EDITION_SORT_MAP);

const PositiveIntSchema = Joi.number().integer().min(0);

type TdhEditionsQuery = {
  contract?: string;
  token_id?: number;
  edition_id?: number;
  sort: string;
  sort_direction: string;
  page: number;
  page_size: number;
};

const TdhEditionsQuerySchema: Joi.ObjectSchema<TdhEditionsQuery> = Joi.object({
  contract: Joi.string().trim().lowercase(),
  token_id: PositiveIntSchema,
  edition_id: PositiveIntSchema,
  sort: Joi.string()
    .trim()
    .lowercase()
    .valid(...SORT_FIELDS)
    .default(DEFAULT_TDH_EDITION_SORT),
  sort_direction: Joi.string()
    .trim()
    .uppercase()
    .valid('ASC', 'DESC')
    .default('DESC'),
  page: Joi.number().integer().positive().default(1),
  page_size: Joi.number().integer().positive().max(100).default(50)
});

const WalletParamsSchema = Joi.object({
  wallet: Joi.string().pattern(WALLET_REGEX).lowercase().required()
});

const IdentityParamsSchema = Joi.object({
  identity: Joi.string().required()
});

function mapFilters(query: TdhEditionsQuery): TdhEditionFilters {
  return {
    contract: query.contract,
    tokenId: query.token_id,
    editionId: query.edition_id
  };
}

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

router.get('/wallet/:wallet', async (req, res) => {
  const { wallet } = getValidatedByJoiOrThrow(req.params, WalletParamsSchema);
  const query = getValidatedByJoiOrThrow<TdhEditionsQuery>(
    req.query,
    TdhEditionsQuerySchema
  );

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
  await returnPaginatedResult(response, req, res);
});

router.get('/identity/:identity', async (req, res) => {
  const { identity: identityParam } = getValidatedByJoiOrThrow(
    req.params,
    IdentityParamsSchema
  );
  const query = getValidatedByJoiOrThrow<TdhEditionsQuery>(
    req.query,
    TdhEditionsQuerySchema
  );
  const timer = Timer.getFromRequest(req);
  const identity =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      {
        identityKey: identityParam
      },
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
        {
          ...row,
          consolidation_key: identity.consolidation_key
        },
        profile
      ),
    result
  );
  await returnPaginatedResult(response, req, res);
});
