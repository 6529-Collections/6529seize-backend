import * as Operations from '@/api/generated/routes/operations';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import { ApiCollectKind } from '@/api/generated/models/ApiCollectKind';
import { ApiCollectFacetTraitEnum } from '@/api/generated/models/ApiCollectFacet';
import {
  ApiCollectCapabilitiesProfileScopeEnum,
  ApiCollectCapabilitiesCreatorFeesEnum
} from '@/api/generated/models/ApiCollectCapabilities';
import { ApiCollectCapabilityActionEnum } from '@/api/generated/models/ApiCollectCapability';
import { collectingService } from '@/collecting/collecting.service';
import {
  CollectingAnalysisRequest,
  CollectingFamily
} from '@/collecting/collecting.types';
import { BadRequestException } from '@/exceptions';
import * as Joi from 'joi';

const identifier = Joi.string().min(1).max(100);
const uint = Joi.string().pattern(/^(0|[1-9][0-9]{0,77})$/);
export const analysisSchema = Joi.object({
  profile_id: identifier.required(),
  kind: Joi.string()
    .valid(...Object.values(ApiCollectKind))
    .required(),
  catalog_version: identifier,
  season_id: Joi.number().integer().min(1),
  artist_id: identifier,
  include_collaborations: Joi.boolean(),
  universe: Joi.string().valid('released', 'tdh_eligible'),
  trait: Joi.string().valid('Palette', 'Size', 'Traced'),
  target_copies: uint,
  assets: Joi.array()
    .max(250)
    .items(
      Joi.object({
        asset_key: Joi.string().min(1).max(150).required(),
        quantity: uint.required()
      })
    ),
  recipient: Joi.string().pattern(/^0x[0-9a-fA-F]{40}$/)
});

export function handleGetCollectCapabilities(
  _req: Operations.GetCollectCapabilitiesRequest
): Operations.GetCollectCapabilitiesResponse {
  return {
    version: 'collect-v1',
    chain_id: 1,
    profile_scope:
      ApiCollectCapabilitiesProfileScopeEnum.ConfirmedConsolidation,
    families: Object.values(ApiCollectFamily),
    provider: 'OpenSea',
    creator_fees: ApiCollectCapabilitiesCreatorFeesEnum.SignedOrderTerms,
    platform_fee_bps: 0,
    actions: Object.values(ApiCollectCapabilityActionEnum).map((action) => {
      if (action === ApiCollectCapabilityActionEnum.RuleExecution)
        return {
          action,
          enabled: false,
          reason:
            'Rules prepare purchases for your review. Automatic wallet execution is not available.'
        };
      const enabled =
        action === ApiCollectCapabilityActionEnum.TdhScenario ||
        (Boolean(process.env.ALCHEMY_API_KEY) &&
          (action === ApiCollectCapabilityActionEnum.Cancel ||
            (Boolean(process.env.OPENSEA_API_KEY) &&
              (process.env.MARKETPLACE_TRADING_ENABLED ?? 'true') === 'true')));
      return {
        action,
        enabled,
        reason: enabled
          ? null
          : 'Trading is temporarily unavailable. Existing orders can still be reviewed.'
      };
    })
  };
}

export async function handleGetCollectCatalog(
  _req: Operations.GetCollectCatalogRequest
): Promise<Operations.GetCollectCatalogResponse> {
  const catalog = await collectingService.getCatalog();
  return {
    version: catalog.version,
    chain_id: catalog.chain_id,
    seasons: catalog.seasons,
    artists: catalog.artists,
    pebbles_traits: catalog.pebbles_traits.map((facet) => ({
      ...facet,
      trait: facet.trait as ApiCollectFacetTraitEnum
    })),
    tdh_snapshot: catalog.tdh_snapshot
  };
}

export async function handleGetCollectAssets(
  req: Operations.GetCollectAssetsRequest
): Promise<Operations.GetCollectAssetsResponse> {
  const validation = Joi.object({
    family: Joi.string().valid(...Object.values(ApiCollectFamily)),
    query: Joi.string().allow('').max(100),
    page: Joi.number().integer().min(1).max(10000).default(1),
    page_size: Joi.number().integer().min(1).max(48).default(24)
  }).validate(req.query, { abortEarly: true });
  if (validation.error)
    throw new BadRequestException('Invalid collection search.');
  const query = validation.value as {
    family?: CollectingFamily;
    query?: string;
    page: number;
    page_size: number;
  };
  const result = await collectingService.listAssets(query);
  return {
    ...result,
    data: result.data.map((asset) => ({
      ...asset,
      family: asset.family as ApiCollectFamily
    }))
  };
}

export async function handleAnalyzeCollectGoal(
  req: Operations.AnalyzeCollectGoalRequest
): Promise<Operations.AnalyzeCollectGoalResponse> {
  req.res?.set('Cache-Control', 'private, no-store');
  const validation = analysisSchema.validate(req.body, { convert: false });
  if (validation.error)
    throw new BadRequestException('Invalid collecting goal.');
  const result = await collectingService.analyze(
    validation.value as CollectingAnalysisRequest
  );
  return { ...result, kind: result.kind as ApiCollectKind };
}
