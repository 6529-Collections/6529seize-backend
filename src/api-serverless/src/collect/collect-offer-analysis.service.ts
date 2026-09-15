import { randomUUID } from 'node:crypto';
import { AuthenticationContext } from '@/auth-context';
import { collectingService } from '@/collecting/collecting.service';
import { collectingDb } from '@/collecting/collecting.db';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { CollectingAsset } from '@/collecting/collecting.types';
import { CollectingWorkBudget } from '@/collecting/collecting-work-budget';
import { marketChain } from '@/marketplace/market-chain';
import { marketUintSchema } from '@/marketplace/seaport.schema';
import { MARKET_WETH } from '@/marketplace/seaport.registry';
import {
  CustomApiCompliantException,
  ForbiddenException,
  BadRequestException
} from '@/exceptions';
import {
  assertMarketActor,
  assertMarketEnabled
} from '@/api/marketplace/marketplace.service';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { collectOfferExposure } from '@/collecting/collecting-offer-exposure.db';
import { collectOfferSignals } from '@/collecting/collecting-offer-signals';
import { allocateCollectOffers } from '@/collecting/collecting-offer-analysis';
import {
  OFFER_ANALYSIS_POLICY,
  OFFER_ANALYSIS_FRESH_MILLIS,
  OFFER_ANALYSIS_TTL_MILLIS,
  OfferAnalysisRequest,
  OfferAnalysisRow
} from '@/collecting/collecting-offer-analysis.types';
import { ApiCollectOfferAnalysis } from '@/api/generated/models/ApiCollectOfferAnalysis';
import {
  ApiCollectOfferAnalysisRow,
  ApiCollectOfferAnalysisRowStatusEnum
} from '@/api/generated/models/ApiCollectOfferAnalysisRow';
import { ApiCollectOfferPriceReferenceKindEnum } from '@/api/generated/models/ApiCollectOfferPriceReference';
import { ApiCollectFamily } from '@/api/generated/models/ApiCollectFamily';
import { ApiMarketKind } from '@/api/generated/models/ApiMarketKind';

function rowDto(
  row: OfferAnalysisRow,
  asset?: CollectingAsset
): ApiCollectOfferAnalysisRow {
  return {
    ...row,
    ...(asset
      ? { asset: { ...asset, family: asset.family as ApiCollectFamily } }
      : {}),
    status: row.status as ApiCollectOfferAnalysisRowStatusEnum,
    references: row.references.map((reference) => ({
      ...reference,
      kind: reference.kind as ApiCollectOfferPriceReferenceKindEnum
    })),
    prepare_request: row.prepare_request
      ? { ...row.prepare_request, kind: ApiMarketKind.Offer }
      : undefined
  };
}

async function readOfferBooks(
  request: OfferAnalysisRequest,
  assets: CollectingAsset[],
  budget: CollectingWorkBudget
) {
  if (
    request.assets.every((asset) => asset.manual_unit_amount_wei !== undefined)
  )
    return [];
  const requested = new Set(
    request.assets.map((asset) => asset.asset_key.toLowerCase())
  );
  const families = new Map(
    assets
      .filter((asset) => requested.has(asset.asset_key))
      .map((asset) => [asset.family, asset])
  );
  const books = await budget.waitFor(() =>
    Promise.all(
      Array.from(families.values()).map((asset) =>
        marketDepthApiDb.getBooks(
          {
            contract: asset.contract.toLowerCase(),
            token_id: asset.token_id,
            collection_id: asset.family === 'pebbles' ? 1 : null
          },
          'all'
        )
      )
    )
  );
  return books.flat();
}

function assertAnalysisActor(
  auth: AuthenticationContext,
  request: OfferAnalysisRequest,
  now: number
) {
  const actor = assertMarketActor(auth);
  if (request.recipient.toLowerCase() !== request.wallet.toLowerCase())
    throw new BadRequestException(
      'Offers currently deliver NFTs to the paying wallet.'
    );
  if (
    actor.profileId !== request.profile_id ||
    actor.wallet !== request.wallet.toLowerCase()
  )
    throw new ForbiddenException(
      'Analyze offers with the directly connected paying wallet and profile.'
    );
  const seconds = Math.floor(now / 1000);
  if (
    request.expires_at < seconds + 300 ||
    request.expires_at > seconds + 86400 * 30
  )
    throw new BadRequestException(
      'Choose an offer expiry between five minutes and thirty days.'
    );
  assertMarketEnabled();
  return actor;
}

export async function analyzeCollectOffers(
  auth: AuthenticationContext,
  request: OfferAnalysisRequest,
  budget = new CollectingWorkBudget()
): Promise<ApiCollectOfferAnalysis> {
  const createdAt = Date.now();
  const actor = assertAnalysisActor(auth, request, createdAt);
  const [catalog, holdings] = await budget.waitFor(() =>
    Promise.all([
      collectingService.getCatalog(),
      collectingDb.readAccountHoldings(actor.profileId)
    ])
  );
  const wallets = holdings.account.wallets.map((wallet) =>
    wallet.toLowerCase()
  );
  if (!wallets.includes(actor.wallet))
    throw new ForbiddenException(
      'The paying wallet is no longer in this profile.'
    );
  if (
    !wallets.includes(request.recipient.toLowerCase()) &&
    !request.acknowledge_external_recipient
  )
    throw new BadRequestException(
      'Review the third-party recipient before continuing.'
    );
  const chain = marketChain();
  const readBalance = async () => {
    await budget.waitFor(() => chain.snapshot());
    return budget.waitFor(() =>
      chain.currencyBalance(MARKET_WETH, actor.wallet)
    );
  };
  const [books, liability, balance, code] = await Promise.all([
    readOfferBooks(request, catalog.assets, budget),
    budget.waitFor(() => collectOfferExposure(actor.wallet)),
    readBalance(),
    budget.waitFor(() => chain.rpc.getCode(actor.wallet))
  ]);
  if (code !== '0x')
    throw new BadRequestException(
      'Trading from this smart wallet is not available yet.'
    );
  if (!marketUintSchema.safeParse(balance).success)
    throw new CustomApiCompliantException(
      503,
      'The WETH balance could not be checked.',
      'FUNDING_UNAVAILABLE'
    );
  const available =
    BigInt(balance) > liability ? BigInt(balance) - liability : BigInt(0);
  const now = Date.now();
  const observed = collectOfferSignals(
    request,
    catalog.assets,
    books,
    wallets,
    now,
    budget.child(8000, 2000)
  );
  budget.assertAvailable();
  const allocation = allocateCollectOffers(
    request,
    observed.signals,
    available
  );
  const references = allocation.rows.flatMap((row) => row.references);
  const validUntil = Math.min(
    createdAt + OFFER_ANALYSIS_TTL_MILLIS,
    request.expires_at * 1000,
    ...references.map((reference) =>
      Math.min(
        reference.expires_at,
        reference.observed_at + OFFER_ANALYSIS_FRESH_MILLIS
      )
    )
  );
  const byKey = new Map(
    catalog.assets.map((asset) => [
      collectingAssetKey(asset.contract, asset.token_id),
      asset
    ])
  );
  const response: ApiCollectOfferAnalysis = {
    analysis_id: randomUUID(),
    policy_version: OFFER_ANALYSIS_POLICY,
    created_at: createdAt,
    valid_until: validUntil,
    profile_id: actor.profileId,
    wallet: actor.wallet,
    recipient: request.recipient.toLowerCase(),
    currency: MARKET_WETH,
    rows: allocation.rows.map((row) => rowDto(row, byKey.get(row.asset_key))),
    totals: {
      proposed_weth_wei: allocation.proposed_weth_wei,
      tracked_payer_liability_wei: liability.toString(),
      weth_balance_wei: balance,
      available_weth_wei: available.toString(),
      ...(request.max_total_weth_wei === undefined
        ? {}
        : { budget_wei: request.max_total_weth_wei }),
      unallocated_weth_wei: allocation.unallocated_weth_wei
    },
    coverage: {
      complete: false,
      indexed_complete:
        observed.signals.size > 0 &&
        Array.from(observed.signals.values()).every(
          (signal) => signal.coverage_complete
        ),
      evaluated_order_count: observed.evaluated_order_count,
      applicable_order_count: observed.applicable_order_count,
      external_orders: 'NOT_COMPREHENSIVE',
      funding_reserved: false,
      execution_verified: false
    },
    signing_policy: 'INDIVIDUAL_OFFERS',
    policy_description:
      request.method.kind === 'goal'
        ? 'For the supplied exact NFTs, preserve every manual pin, then select the largest number of remaining NFTs within capacity at fixed patient openings, preferring lower total commitments and stable asset order. An automatic opening needs an ERC1155 ask with at least three distinct observed makers and complete indexed coverage: 70% of that ask, reduced a further 5% when fewer than two bid makers are observed. These are conservative policy parameters, not fair value or acceptance probabilities; unallocated WETH stays uncommitted.'
        : 'Every amount follows the selected explicit per-NFT price or one-time formula. Manual pins are preserved. Formula references are indexed, terms-applicable observations; current funding and execution remain unverified until the separate offer review. Offers can be accepted independently and do not guarantee set completion.'
  };
  budget.assertAvailable();
  if (validUntil <= Date.now())
    throw new CustomApiCompliantException(
      503,
      'Offer analysis sources changed. Analyze again before reviewing offers.',
      'ANALYSIS_EXPIRED'
    );
  return response;
}
