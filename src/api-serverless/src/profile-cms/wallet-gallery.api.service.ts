import { appFeatures } from '@/app-features';
import { ForbiddenException, BadRequestException } from '@/exceptions';
import {
  normalizeEthereumAddress,
  walletGalleryAddressNormalizer,
  WalletGalleryAddressNormalizer
} from '@/profile-cms/wallet-gallery/wallet-gallery-address-normalizer';
import {
  normalizeWalletGalleryMedia,
  WalletGalleryNormalizedMedia
} from '@/profile-cms/wallet-gallery/wallet-gallery-media-normalizer';
import {
  WalletGallerySnapshotDb,
  walletGallerySnapshotDb
} from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.db';
import {
  WalletGalleryCollectionKey,
  WalletGalleryOwnershipRow,
  WalletGalleryWalletInputResolution
} from '@/profile-cms/wallet-gallery/wallet-gallery-snapshot.types';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';

export interface CreateProfileCmsWalletGallerySnapshotRequest {
  readonly wallets: string[];
  readonly exclude_contracts?: string[];
  readonly exclude_assets?: ProfileCmsWalletGalleryAssetIdentifierRequest[];
  readonly include_spam?: boolean;
  readonly max_assets?: number;
}

export interface ProfileCmsWalletGalleryAssetIdentifierRequest {
  readonly contract: string;
  readonly token_id: number;
}

export interface ProfileCmsWalletGallerySnapshotResponse {
  readonly generated_at: number;
  readonly source: 'indexed_ownership';
  readonly block_reference: number;
  readonly wallets: WalletGalleryWalletInputResolution[];
  readonly assets: ProfileCmsWalletGalleryAssetResponse[];
  readonly excluded_assets: ProfileCmsWalletGalleryExcludedAssetResponse[];
  readonly totals: ProfileCmsWalletGalleryTotalsResponse;
}

export interface ProfileCmsWalletGalleryAssetResponse {
  readonly contract: string;
  readonly token_id: number;
  readonly balance: number;
  readonly owner_wallet: string;
  readonly owner_display: string | null;
  readonly collection: string;
  readonly collection_key: WalletGalleryCollectionKey;
  readonly name: string;
  readonly description: string | null;
  readonly artist: string | null;
  readonly artist_seize_handle: string | null;
  readonly token_type: string | null;
  readonly media: WalletGalleryNormalizedMedia;
  readonly metadata: unknown;
  readonly flags: ProfileCmsWalletGalleryAssetFlagsResponse;
}

export interface ProfileCmsWalletGalleryAssetFlagsResponse {
  readonly spam: boolean;
  readonly excluded: boolean;
  readonly exclusion_reason: string | null;
}

export interface ProfileCmsWalletGalleryExcludedAssetResponse {
  readonly contract: string;
  readonly token_id: number;
  readonly owner_wallet: string;
  readonly reason: string;
}

export interface ProfileCmsWalletGalleryTotalsResponse {
  readonly requested_wallets: number;
  readonly resolved_wallets: number;
  readonly unresolved_wallets: number;
  readonly indexed_assets: number;
  readonly visible_assets: number;
  readonly excluded_assets: number;
  readonly spam_assets: number;
  readonly truncated: boolean;
}

interface NormalizedAssetIdentifier {
  readonly contract: string;
  readonly tokenId: number;
}

interface ExclusionMatch {
  readonly excluded: boolean;
  readonly reason: string | null;
}

const DEFAULT_MAX_ASSETS = 200;
const MAX_MAX_ASSETS = 500;

export class ProfileCmsWalletGalleryApiService {
  constructor(
    private readonly snapshotDb: WalletGallerySnapshotDb,
    private readonly addressNormalizer: WalletGalleryAddressNormalizer,
    private readonly isFeatureEnabled: () => boolean,
    private readonly currentMillis: () => number
  ) {}

  async createSnapshot(
    request: CreateProfileCmsWalletGallerySnapshotRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsWalletGallerySnapshotResponse> {
    if (!this.isFeatureEnabled()) {
      throw new ForbiddenException(
        'Profile CMS wallet gallery snapshots are not enabled'
      );
    }
    const normalizedInputs = await this.addressNormalizer.normalizeWalletInputs(
      request.wallets,
      ctx
    );
    const holdings = await this.snapshotDb.findHoldingsByWallets(
      normalizedInputs.addresses,
      ctx
    );
    const sortedHoldings = [...holdings].sort(compareOwnershipRows);
    const exclusions = this.normalizeExclusions(request);
    const visibleAssets: ProfileCmsWalletGalleryAssetResponse[] = [];
    const excludedAssets: ProfileCmsWalletGalleryExcludedAssetResponse[] = [];

    sortedHoldings.forEach((row) => {
      const match = getExclusionMatch(row, exclusions);
      if (match.excluded) {
        excludedAssets.push(toExcludedAsset(row, match.reason ?? 'excluded'));
        return;
      }
      visibleAssets.push(toVisibleAsset(row));
    });

    const maxAssets = normalizeMaxAssets(request.max_assets);
    const limitedAssets = visibleAssets.slice(0, maxAssets);
    const unresolvedWallets = normalizedInputs.inputs.filter(
      (input) => input.status === 'unresolved'
    ).length;

    return {
      generated_at: this.currentMillis(),
      source: 'indexed_ownership',
      block_reference: getMaxBlockReference(sortedHoldings),
      wallets: normalizedInputs.inputs,
      assets: limitedAssets,
      excluded_assets: excludedAssets,
      totals: {
        requested_wallets: request.wallets.length,
        resolved_wallets: normalizedInputs.addresses.length,
        unresolved_wallets: unresolvedWallets,
        indexed_assets: sortedHoldings.length,
        visible_assets: limitedAssets.length,
        excluded_assets: excludedAssets.length,
        spam_assets: 0,
        truncated: visibleAssets.length > limitedAssets.length
      }
    };
  }

  private normalizeExclusions(
    request: CreateProfileCmsWalletGallerySnapshotRequest
  ): {
    readonly contracts: ReadonlySet<string>;
    readonly assets: ReadonlySet<string>;
  } {
    const contracts = new Set<string>();
    (request.exclude_contracts ?? []).forEach((contract) => {
      contracts.add(normalizeAddressOrThrow(contract, 'exclude_contracts'));
    });
    const assets = new Set<string>();
    (request.exclude_assets ?? []).forEach((asset) => {
      assets.add(
        assetKey({
          contract: normalizeAddressOrThrow(asset.contract, 'exclude_assets'),
          tokenId: normalizeTokenIdOrThrow(asset.token_id, 'exclude_assets')
        })
      );
    });
    return { contracts, assets };
  }
}

export const profileCmsWalletGalleryApiService =
  new ProfileCmsWalletGalleryApiService(
    walletGallerySnapshotDb,
    walletGalleryAddressNormalizer,
    () => appFeatures.isProfileCmsWalletGalleryEnabled(),
    Time.currentMillis
  );

function getExclusionMatch(
  row: WalletGalleryOwnershipRow,
  exclusions: {
    readonly contracts: ReadonlySet<string>;
    readonly assets: ReadonlySet<string>;
  }
): ExclusionMatch {
  const contract = row.contract.toLowerCase();
  if (exclusions.contracts.has(contract)) {
    return { excluded: true, reason: 'contract_excluded' };
  }
  if (
    exclusions.assets.has(
      assetKey({
        contract,
        tokenId: normalizeTokenIdOrThrow(row.token_id, 'indexed_asset')
      })
    )
  ) {
    return { excluded: true, reason: 'asset_excluded' };
  }
  return { excluded: false, reason: null };
}

function toVisibleAsset(
  row: WalletGalleryOwnershipRow
): ProfileCmsWalletGalleryAssetResponse {
  const tokenId = normalizeTokenIdOrThrow(row.token_id, 'indexed_asset');
  return {
    contract: row.contract.toLowerCase(),
    token_id: tokenId,
    balance: normalizeBalance(row.balance),
    owner_wallet: row.owner_wallet.toLowerCase(),
    owner_display: row.owner_display ?? null,
    collection: row.collection ?? row.collection_key,
    collection_key: row.collection_key,
    name: row.name ?? `${row.collection_key} #${tokenId}`,
    description: row.description ?? null,
    artist: row.artist ?? null,
    artist_seize_handle: row.artist_seize_handle ?? null,
    token_type: row.token_type ?? null,
    media: normalizeWalletGalleryMedia(row),
    metadata: normalizeMetadata(row.metadata),
    flags: {
      spam: false,
      excluded: false,
      exclusion_reason: null
    }
  };
}

function toExcludedAsset(
  row: WalletGalleryOwnershipRow,
  reason: string
): ProfileCmsWalletGalleryExcludedAssetResponse {
  return {
    contract: row.contract.toLowerCase(),
    token_id: normalizeTokenIdOrThrow(row.token_id, 'indexed_asset'),
    owner_wallet: row.owner_wallet.toLowerCase(),
    reason
  };
}

function normalizeMetadata(metadata: unknown): unknown {
  if (typeof metadata !== 'string') {
    return metadata ?? null;
  }
  try {
    return JSON.parse(metadata);
  } catch {
    return metadata;
  }
}

function normalizeAddressOrThrow(input: string, field: string): string {
  const address = normalizeEthereumAddress(input);
  if (!address) {
    throw new BadRequestException(`${field} contains an invalid contract`);
  }
  return address;
}

function normalizeTokenIdOrThrow(
  input: number | string,
  field: string
): number {
  const value = Number(input);
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} contains an invalid token_id`);
  }
  return value;
}

function normalizeBalance(input: number | string): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : 0;
}

function normalizeMaxAssets(maxAssets: number | undefined): number {
  if (!maxAssets) {
    return DEFAULT_MAX_ASSETS;
  }
  return Math.min(maxAssets, MAX_MAX_ASSETS);
}

function getMaxBlockReference(rows: WalletGalleryOwnershipRow[]): number {
  return rows.reduce((max, row) => {
    const block = Number(row.block_reference ?? 0);
    return Number.isFinite(block) ? Math.max(max, block) : max;
  }, 0);
}

function compareOwnershipRows(
  left: WalletGalleryOwnershipRow,
  right: WalletGalleryOwnershipRow
): number {
  const collectionComparison =
    getCollectionOrder(left.collection_key) -
    getCollectionOrder(right.collection_key);
  if (collectionComparison !== 0) {
    return collectionComparison;
  }
  const contractComparison = left.contract
    .toLowerCase()
    .localeCompare(right.contract.toLowerCase());
  if (contractComparison !== 0) {
    return contractComparison;
  }
  const tokenComparison =
    normalizeTokenIdOrThrow(left.token_id, 'indexed_asset') -
    normalizeTokenIdOrThrow(right.token_id, 'indexed_asset');
  if (tokenComparison !== 0) {
    return tokenComparison;
  }
  return left.owner_wallet
    .toLowerCase()
    .localeCompare(right.owner_wallet.toLowerCase());
}

function getCollectionOrder(collectionKey: WalletGalleryCollectionKey): number {
  switch (collectionKey) {
    case WalletGalleryCollectionKey.MEMES:
      return 1;
    case WalletGalleryCollectionKey.GRADIENTS:
      return 2;
    case WalletGalleryCollectionKey.MEMELAB:
      return 3;
    case WalletGalleryCollectionKey.NEXTGEN:
      return 4;
  }
}

function assetKey(asset: NormalizedAssetIdentifier): string {
  return `${asset.contract.toLowerCase()}:${asset.tokenId}`;
}
