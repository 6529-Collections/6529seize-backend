import { analyzeCollectingGoal } from '@/collecting/collecting-analysis';
import { collectingDb, CollectingDb } from '@/collecting/collecting.db';
import {
  CollectingAnalysisRequest,
  CollectingAssetSearch,
  CollectingCatalog
} from '@/collecting/collecting.types';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import {
  assertCollectingTdhParity,
  CollectingTdhProjectionRequest,
  CollectingPurchaseProjectionRequest,
  projectCollectingTdh
} from '@/collecting/collecting-tdh-projection';
import {
  CollectingQuotedTdhCandidate,
  prepareCollectingPurchaseProjection,
  rankCollectingTdhQuotes
} from '@/collecting/collecting-tdh-ranking';

const CATALOG_CACHE_MILLIS = 30000;

export class CollectingService {
  private cache: { expires: number; value: CollectingCatalog } | undefined;
  private pending: Promise<CollectingCatalog> | undefined;

  constructor(
    private readonly db: Pick<
      CollectingDb,
      'readCatalog' | 'readAccountHoldings' | 'readTdhProjectionSource'
    >,
    private readonly now: () => number = Date.now
  ) {}

  async getCatalog(): Promise<CollectingCatalog> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.value;
    if (!this.pending) {
      this.pending = this.db
        .readCatalog()
        .then((value) => {
          this.cache = { value, expires: Date.now() + CATALOG_CACHE_MILLIS };
          return value;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  async listAssets(request: CollectingAssetSearch) {
    if (
      !Number.isSafeInteger(request.page) ||
      request.page < 1 ||
      !Number.isSafeInteger(request.page_size) ||
      request.page_size < 1 ||
      request.page_size > 100 ||
      (request.query?.length ?? 0) > 200
    ) {
      throw new BadRequestException('Invalid collecting search');
    }
    const catalog = await this.getCatalog();
    const search = request.query?.trim().toLowerCase() ?? '';
    const matchingArtists = new Set(
      catalog.artists
        .filter((artist) => artist.name.toLowerCase().includes(search))
        .map((artist) => artist.id)
    );
    const assets = catalog.assets.filter(
      (asset) =>
        (!request.family || asset.family === request.family) &&
        (!search ||
          asset.name.toLowerCase().includes(search) ||
          asset.token_id === search ||
          asset.artist_ids.some((id) => matchingArtists.has(id)))
    );
    const start = (request.page - 1) * request.page_size;
    return {
      count: assets.length,
      page: request.page,
      next: start + request.page_size < assets.length,
      data: assets.slice(start, start + request.page_size),
      catalog_version: catalog.version
    };
  }

  async analyze(request: CollectingAnalysisRequest) {
    const catalog = await this.getCatalog();
    const scope = await this.db.readAccountHoldings(request.profile_id);
    const pebbleKeys = new Set(
      catalog.assets
        .filter((asset) => asset.family === 'pebbles')
        .map((asset) => asset.asset_key)
    );
    const includesPebbles =
      request.kind === 'pebbles_trait_set' ||
      request.kind === 'pebbles_ultimate' ||
      (request.assets ?? []).some((asset) => pebbleKeys.has(asset.asset_key));
    if (includesPebbles && scope.snapshot.nextgen_block_number === null) {
      throw new CustomApiCompliantException(
        503,
        'NextGen holdings snapshot is not available'
      );
    }
    return analyzeCollectingGoal(
      catalog,
      scope.account,
      scope.holdings,
      scope.snapshot,
      request
    );
  }

  async projectTdh(request: CollectingTdhProjectionRequest) {
    const source = await this.db.readTdhProjectionSource(request.profile_id);
    assertCollectingTdhParity(source.input, source.official);
    return {
      account: source.account,
      ...projectCollectingTdh({
        ...source.input,
        evaluated_at: request.evaluated_at,
        transfers: request.transfers
      })
    };
  }

  async projectPurchases(request: CollectingPurchaseProjectionRequest) {
    const source = await this.db.readTdhProjectionSource(request.profile_id);
    const scenario = prepareCollectingPurchaseProjection(
      source,
      request,
      this.now()
    );
    assertCollectingTdhParity(source.input, source.official);
    return {
      account: source.account,
      horizon_days: request.horizon_days,
      acquisition_timestamp: scenario.acquisition_timestamp,
      recipient_allocations: scenario.allocations,
      ...projectCollectingTdh(scenario.input)
    };
  }

  async rankTdhPurchases(
    request: Pick<
      CollectingPurchaseProjectionRequest,
      'profile_id' | 'horizon_days'
    >,
    candidates: CollectingQuotedTdhCandidate[]
  ) {
    const source = await this.db.readTdhProjectionSource(request.profile_id);
    return rankCollectingTdhQuotes(
      source,
      request.horizon_days,
      candidates,
      this.now()
    );
  }
}

export const collectingService = new CollectingService(collectingDb);
