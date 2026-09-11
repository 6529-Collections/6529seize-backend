import { createHash } from 'node:crypto';
import { isAddress } from 'ethers';
import { BadRequestException } from '@/exceptions';
import {
  CollectingAccount,
  CollectingAnalysis,
  CollectingAnalysisRequest,
  CollectingCatalog,
  CollectingHolding,
  CollectingRequirement,
  PebblesTrait
} from '@/collecting/collecting.types';

export const PEBBLES_SET_TRAITS: readonly PebblesTrait[] = [
  'Palette',
  'Size',
  'Traced'
];

export function collectingHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function collectingAssetKey(contract: string, tokenId: string): string {
  if (
    !/^(0|[1-9]\d{0,77})$/.test(tokenId) ||
    BigInt(tokenId) >
      BigInt(
        '115792089237316195423570985008687907853269984665640564039457584007913129639935'
      )
  ) {
    throw new BadRequestException('Invalid token ID');
  }
  return `1:${contract.toLowerCase()}:${tokenId}`;
}

function positiveQuantity(value: string): bigint {
  if (!/^[1-9]\d{0,3}$/.test(value)) {
    throw new BadRequestException(
      'Quantity must be a positive integer of at most 9999'
    );
  }
  return BigInt(value);
}

interface RequirementDefinition {
  id: string;
  label: string;
  target: bigint;
  assets: string[];
}

function exactRequirements(
  catalog: CollectingCatalog,
  items: Array<{ asset_key: string; quantity: string }>
): RequirementDefinition[] {
  if (!items.length || items.length > 2000)
    throw new BadRequestException('Select between 1 and 2000 assets');
  const seen = new Set<string>();
  const byKey = new Map(
    catalog.assets.map((asset) => [asset.asset_key, asset])
  );
  return items.map((item) => {
    const asset = byKey.get(item.asset_key);
    if (!asset || seen.has(item.asset_key))
      throw new BadRequestException('Unknown or repeated asset');
    seen.add(item.asset_key);
    const target = positiveQuantity(item.quantity);
    if (asset.family !== 'memes' && target !== BigInt(1))
      throw new BadRequestException('Unique NFTs require quantity one');
    return {
      id: item.asset_key,
      label: asset.name,
      target,
      assets: [item.asset_key]
    };
  });
}

function traitRequirements(
  catalog: CollectingCatalog,
  request: CollectingAnalysisRequest
): RequirementDefinition[] {
  if ((request.target_copies ?? '1') !== '1')
    throw new BadRequestException(
      'Pebbles trait goals currently support one complete set'
    );
  const selected =
    request.kind === 'pebbles_ultimate'
      ? Array.from(PEBBLES_SET_TRAITS)
      : [request.trait];
  if (selected.some((trait) => !trait || !PEBBLES_SET_TRAITS.includes(trait))) {
    throw new BadRequestException('Choose a Pebbles set trait');
  }
  return selected.flatMap((trait) => {
    const definition = catalog.pebbles_traits.find(
      (item) => item.trait === trait
    );
    if (!definition?.values.length)
      throw new BadRequestException('Pebbles trait catalog is not available');
    return definition.values.map((value) => ({
      id: `pebbles:${trait}:${value}`,
      label: `${trait}: ${value}`,
      target: BigInt(1),
      assets: catalog.assets
        .filter(
          (asset) =>
            asset.family === 'pebbles' &&
            asset.traits.some(
              (item) => item.trait === trait && item.value === value
            )
        )
        .map((asset) => asset.asset_key)
    }));
  });
}

function selectedAssetKeys(
  catalog: CollectingCatalog,
  request: CollectingAnalysisRequest
): string[] {
  switch (request.kind) {
    case 'memes_full_set':
      return catalog.assets
        .filter((asset) => asset.family === 'memes')
        .map((asset) => asset.asset_key);
    case 'gradients_full_set':
      return catalog.assets
        .filter((asset) => asset.family === 'gradients')
        .map((asset) => asset.asset_key);
    case 'memes_season': {
      const season = catalog.seasons.find(
        (item) => item.id === request.season_id
      );
      if (!season) throw new BadRequestException('Unknown Meme season');
      return season.asset_keys;
    }
    case 'memes_artist': {
      const artist = catalog.artists.find(
        (item) => item.id === request.artist_id
      );
      if (!artist) throw new BadRequestException('Unknown artist');
      const collaborators = new Set(artist.collaboration_asset_keys);
      return artist.asset_keys.filter(
        (key) =>
          request.include_collaborations !== false || !collaborators.has(key)
      );
    }
    default:
      throw new BadRequestException('Unsupported collecting goal');
  }
}

function buildDefinitions(
  catalog: CollectingCatalog,
  request: CollectingAnalysisRequest
): RequirementDefinition[] {
  if (
    request.kind === 'pebbles_trait_set' ||
    request.kind === 'pebbles_ultimate'
  )
    return traitRequirements(catalog, request);
  if (request.kind === 'exact')
    return exactRequirements(catalog, request.assets ?? []);
  const quantity = request.target_copies ?? '1';
  positiveQuantity(quantity);
  if (request.universe === 'tdh_eligible' && !catalog.tdh_snapshot)
    throw new BadRequestException('No completed TDH snapshot is available');
  const eligible = new Set(
    catalog.assets
      .filter((asset) => asset.tdh_eligible)
      .map((asset) => asset.asset_key)
  );
  const keys = selectedAssetKeys(catalog, request).filter(
    (key) => request.universe !== 'tdh_eligible' || eligible.has(key)
  );
  return exactRequirements(
    catalog,
    keys.map((asset_key) => ({ asset_key, quantity }))
  );
}

function validateHoldings(
  account: CollectingAccount,
  holdings: CollectingHolding[]
): void {
  const wallets = new Set(
    account.wallets.map((wallet) => wallet.toLowerCase())
  );
  const seen = new Set<string>();
  for (const holding of holdings) {
    const key = `${holding.wallet.toLowerCase()}:${holding.asset_key}`;
    if (
      !wallets.has(holding.wallet.toLowerCase()) ||
      !/^(0|[1-9]\d*)$/.test(holding.quantity) ||
      seen.has(key)
    ) {
      throw new BadRequestException(
        'Holdings snapshot is inconsistent with the account'
      );
    }
    seen.add(key);
  }
}

function measureRequirement(
  definition: RequirementDefinition,
  holdings: CollectingHolding[]
): CollectingRequirement {
  const keys = new Set(definition.assets);
  const owned = holdings.filter(
    (holding) =>
      keys.has(holding.asset_key) && BigInt(holding.quantity) > BigInt(0)
  );
  const quantity = owned.reduce(
    (sum, holding) => sum + BigInt(holding.quantity),
    BigInt(0)
  );
  return {
    id: definition.id,
    label: definition.label,
    target_quantity: definition.target.toString(),
    owned_quantity: quantity.toString(),
    missing_quantity: (quantity < definition.target
      ? definition.target - quantity
      : BigInt(0)
    ).toString(),
    asset_keys: definition.assets,
    holdings: owned
  };
}

export function analyzeCollectingGoal(
  catalog: CollectingCatalog,
  account: CollectingAccount,
  holdings: CollectingHolding[],
  snapshot: CollectingAnalysis['holdings_snapshot'],
  request: CollectingAnalysisRequest
): CollectingAnalysis {
  if (request.profile_id !== account.profile_id)
    throw new BadRequestException('Account does not match the request');
  if (request.catalog_version && request.catalog_version !== catalog.version)
    throw new BadRequestException('Catalog changed; review the new target');
  const recipient = request.recipient?.toLowerCase() ?? null;
  if (request.recipient && !isAddress(request.recipient))
    throw new BadRequestException('Invalid recipient address');
  const recipientInProfile =
    recipient !== null &&
    account.wallets.some((wallet) => wallet.toLowerCase() === recipient);
  validateHoldings(account, holdings);
  const definitions = buildDefinitions(catalog, request);
  const requirements = definitions.map((definition) =>
    measureRequirement(definition, holdings)
  );
  const satisfied = requirements.filter(
    (requirement) => requirement.missing_quantity === '0'
  ).length;
  const result = {
    catalog_version: catalog.version,
    account,
    holdings_snapshot: snapshot,
    kind: request.kind,
    target_copies: request.target_copies ?? '1',
    requirements,
    required_count: requirements.length,
    satisfied_count: satisfied,
    complete: requirements.length > 0 && satisfied === requirements.length,
    missing_asset_keys: Array.from(
      new Set(
        requirements
          .filter((requirement) => requirement.missing_quantity !== '0')
          .flatMap((requirement) => requirement.asset_keys)
      )
    ),
    recipient,
    recipient_in_profile: recipientInProfile,
    counts_toward_profile: recipientInProfile
  };
  return { analysis_id: collectingHash(result), ...result };
}
