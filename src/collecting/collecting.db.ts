import {
  ADDRESS_CONSOLIDATION_KEY,
  ARTISTS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  GRADIENT_CONTRACT,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_SEASONS_TABLE,
  MEME_8_EDITION_BURN_ADJUSTMENT,
  NFT_OWNERS_SYNC_STATE_TABLE,
  NFT_OWNERS_TABLE,
  NFTS_TABLE,
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_TABLE,
  NULL_ADDRESS
} from '@/constants';
import {
  collectingAssetKey,
  collectingHash,
  PEBBLES_SET_TRAITS
} from '@/collecting/collecting-analysis';
import {
  CollectingAccount,
  CollectingAsset,
  CollectingCatalog,
  CollectingHolding
} from '@/collecting/collecting.types';
import {
  BadRequestException,
  CustomApiCompliantException,
  NotFoundException
} from '@/exceptions';
import {
  NEXTGEN_BLOCKS_TABLE,
  NEXTGEN_CORE_CONTRACT,
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKEN_TRAITS_TABLE
} from '@/nextgen/nextgen_constants';
import { Network } from '@/alchemy-sdk';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { MemesSeason } from '@/entities/ISeason';
import { Transaction } from '@/entities/ITransaction';
import {
  CollectingProjectionToken,
  CollectingTdhProjectionInput,
  CollectingOfficialTdh,
  ProjectedToken
} from '@/collecting/collecting-tdh-projection';
import { buildMemeCalculationEditionSizes } from '@/tdhLoop/tdh';

const MAX_CATALOG_ASSETS = 50000;
const MAX_CATALOG_TRAITS = 150000;
export const COLLECTING_PEBBLES_CONTRACT =
  NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET].toLowerCase();

interface NftRow {
  token_id: string;
  contract: string;
  name: string;
  image_url: string | null;
  season: number | null;
  mint_date: Date | string | null;
  hodl_rate: number;
}

interface TraitRow {
  token_id: string;
  trait: string;
  value: string;
}
interface ArtistRow {
  name: string;
  memes: unknown;
}
interface SnapshotRow {
  block_number: number;
  block_timestamp: Date | string;
}

function bounded<T>(rows: T[], maximum: number): T[] {
  if (rows.length > maximum)
    throw new CustomApiCompliantException(
      503,
      'Collecting catalog exceeds the supported snapshot size'
    );
  return rows;
}

function officialTokens(
  raw: unknown,
  contract: string,
  family: CollectingAsset['family'],
  boost: number
): ProjectedToken[] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed))
    throw new CustomApiCompliantException(
      503,
      'Official TDH token snapshot is invalid'
    );
  return parsed.map((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'number' ||
      !Number.isSafeInteger(value.id) ||
      value.id < 0 ||
      !('balance' in value) ||
      !('tdh__raw' in value) ||
      !('hodl_rate' in value) ||
      !('tdh' in value) ||
      ![value.balance, value.tdh__raw, value.hodl_rate, value.tdh].every(
        (number) => typeof number === 'number' && Number.isFinite(number)
      )
    )
      throw new CustomApiCompliantException(
        503,
        'Official TDH token snapshot is invalid'
      );
    return {
      asset_key: collectingAssetKey(contract, String(value.id)),
      family,
      balance: Number(value.balance),
      raw_days_held: Number(value.tdh__raw),
      hodl_rate: Number(value.hodl_rate),
      base_tdh: Number(value.tdh),
      boosted_tdh: Math.round(Number(value.tdh) * boost)
    };
  });
}

function artistMembers(
  raw: unknown
): Array<{ id: number; collboration_with?: string[] }> {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(value))
    throw new CustomApiCompliantException(503, 'Artist catalog is unavailable');
  return value.filter(
    (entry): entry is { id: number; collboration_with?: string[] } =>
      typeof entry === 'object' &&
      entry !== null &&
      Number.isSafeInteger(entry.id) &&
      entry.id > 0
  );
}

function buildCatalog(
  nfts: NftRow[],
  pebbles: NftRow[],
  traits: TraitRow[],
  artists: ArtistRow[],
  snapshot: SnapshotRow | undefined
): CollectingCatalog {
  const assetTraits = new Map<
    string,
    Array<{ trait: string; value: string }>
  >();
  for (const row of traits) {
    const values = assetTraits.get(row.token_id) ?? [];
    values.push({ trait: row.trait, value: row.value });
    assetTraits.set(row.token_id, values);
  }
  const assets: CollectingAsset[] = nfts.map((row) => {
    const contract = row.contract.toLowerCase();
    return {
      asset_key: collectingAssetKey(contract, row.token_id),
      chain_id: 1,
      contract,
      token_id: row.token_id,
      family: contract === MEMES_CONTRACT.toLowerCase() ? 'memes' : 'gradients',
      name: row.name,
      image_url: row.image_url,
      artist_ids: [],
      season: row.season,
      traits: [],
      hodl_rate: Number.isFinite(Number(row.hodl_rate))
        ? Number(row.hodl_rate)
        : null,
      tdh_eligible:
        !!snapshot &&
        !!row.mint_date &&
        new Date(row.mint_date).getTime() <=
          new Date(snapshot.block_timestamp).getTime() - 86400000
    };
  });
  for (const row of pebbles) {
    assets.push({
      asset_key: collectingAssetKey(COLLECTING_PEBBLES_CONTRACT, row.token_id),
      chain_id: 1,
      contract: COLLECTING_PEBBLES_CONTRACT,
      token_id: row.token_id,
      family: 'pebbles',
      name: row.name,
      image_url: row.image_url,
      artist_ids: [],
      season: null,
      traits: assetTraits.get(row.token_id) ?? [],
      hodl_rate: Number.isFinite(Number(row.hodl_rate))
        ? Number(row.hodl_rate)
        : null,
      tdh_eligible:
        !!snapshot &&
        !!row.mint_date &&
        new Date(row.mint_date).getTime() <=
          new Date(snapshot.block_timestamp).getTime()
    });
  }
  assets.sort((a, b) => a.asset_key.localeCompare(b.asset_key));
  const assetMap = new Map(assets.map((asset) => [asset.asset_key, asset]));
  const catalogArtists = artists
    .map((artist) => {
      const id = `artist:${collectingHash(artist.name)}`;
      const members = artistMembers(artist.memes);
      const keys = Array.from(
        new Set(
          members
            .map((member) =>
              collectingAssetKey(MEMES_CONTRACT, String(member.id))
            )
            .filter((key) => assetMap.has(key))
        )
      ).sort((a, b) => a.localeCompare(b));
      keys.forEach((key) => assetMap.get(key)?.artist_ids.push(id));
      return {
        id,
        name: artist.name,
        asset_keys: keys,
        collaboration_asset_keys: Array.from(
          new Set(
            members
              .filter((member) => (member.collboration_with?.length ?? 0) > 0)
              .map((member) =>
                collectingAssetKey(MEMES_CONTRACT, String(member.id))
              )
              .filter((key) => assetMap.has(key))
          )
        ).sort((a, b) => a.localeCompare(b))
      };
    })
    .filter((artist) => artist.asset_keys.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const seasonIds = Array.from(
    new Set(
      assets
        .filter(
          (asset) =>
            asset.family === 'memes' &&
            asset.season !== null &&
            asset.season > 0
        )
        .map((asset) => asset.season!)
    )
  ).sort((a, b) => a - b);
  const content = {
    chain_id: 1,
    assets,
    seasons: seasonIds.map((id) => ({
      id,
      name: `Season ${id}`,
      current: id === seasonIds[seasonIds.length - 1],
      asset_keys: assets
        .filter((asset) => asset.family === 'memes' && asset.season === id)
        .map((asset) => asset.asset_key)
    })),
    artists: catalogArtists,
    pebbles_traits: PEBBLES_SET_TRAITS.map((trait) => ({
      trait,
      values: Array.from(
        new Set(
          traits.filter((row) => row.trait === trait).map((row) => row.value)
        )
      ).sort((a, b) => a.localeCompare(b))
    })),
    tdh_snapshot: snapshot
      ? {
          block_number: Number(snapshot.block_number),
          block_timestamp: new Date(snapshot.block_timestamp).toISOString()
        }
      : null
  };
  return { version: collectingHash(content), ...content };
}

export class CollectingDb {
  constructor(private readonly getDb: () => SqlExecutor) {}

  async readCatalog(): Promise<CollectingCatalog> {
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        const options = { wrappedConnection: connection };
        const db = this.getDb();
        const snapshots = await db.execute<SnapshotRow>(
          `SELECT block_number, timestamp AS block_timestamp FROM ${TDH_BLOCKS_TABLE} ORDER BY block_number DESC LIMIT 1`,
          undefined,
          options
        );
        const nfts = bounded(
          await db.execute<NftRow>(
            `
        SELECT CAST(n.id AS CHAR) AS token_id, n.contract, n.name,
          COALESCE(NULLIF(n.thumbnail, ''), NULLIF(n.image, '')) AS image_url,
          e.season, n.mint_date, n.hodl_rate
        FROM ${NFTS_TABLE} n
        LEFT JOIN ${MEMES_EXTENDED_DATA_TABLE} e ON e.id = n.id AND LOWER(n.contract) = :memes
        WHERE LOWER(n.contract) IN (:contracts) AND n.mint_date IS NOT NULL
        ORDER BY n.contract ASC, n.id ASC LIMIT ${MAX_CATALOG_ASSETS + 1}
      `,
            {
              memes: MEMES_CONTRACT.toLowerCase(),
              contracts: [
                MEMES_CONTRACT.toLowerCase(),
                GRADIENT_CONTRACT.toLowerCase()
              ]
            },
            options
          ),
          MAX_CATALOG_ASSETS
        );
        const pebbles = bounded(
          await db.execute<NftRow>(
            `
        SELECT CAST(id AS CHAR) AS token_id, name, COALESCE(NULLIF(thumbnail_url, ''), NULLIF(image_url, '')) AS image_url, mint_date, hodl_rate
        FROM ${NEXTGEN_TOKENS_TABLE} WHERE collection_id = 1 AND pending = false AND burnt = false
        ORDER BY id ASC LIMIT ${MAX_CATALOG_ASSETS + 1}
      `,
            undefined,
            options
          ),
          MAX_CATALOG_ASSETS
        );
        bounded([...nfts, ...pebbles], MAX_CATALOG_ASSETS);
        const traits = bounded(
          await db.execute<TraitRow>(
            `
        SELECT CAST(token_id AS CHAR) AS token_id, trait, value FROM ${NEXTGEN_TOKEN_TRAITS_TABLE}
        WHERE collection_id = 1 AND trait IN (:traits) ORDER BY token_id ASC, trait ASC LIMIT ${MAX_CATALOG_TRAITS + 1}
      `,
            { traits: PEBBLES_SET_TRAITS },
            options
          ),
          MAX_CATALOG_TRAITS
        );
        const artists = await db.execute<ArtistRow>(
          `SELECT name, memes FROM ${ARTISTS_TABLE} ORDER BY name ASC`,
          undefined,
          options
        );
        return buildCatalog(nfts, pebbles, traits, artists, snapshots[0]);
      }
    );
  }

  async readAccountHoldings(profileId: string) {
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        const account = await this.readAccount(profileId, connection);
        const options = { wrappedConnection: connection };
        const holdings = await this.getDb().execute<{
          contract: string;
          token_id: string;
          wallet: string;
          quantity: string;
        }>(
          `
        SELECT LOWER(contract) AS contract, CAST(token_id AS CHAR) AS token_id, LOWER(wallet) AS wallet, CAST(balance AS CHAR) AS quantity
        FROM ${NFT_OWNERS_TABLE} WHERE wallet IN (:wallets) AND LOWER(contract) IN (:contracts) AND balance > 0
        ORDER BY contract ASC, token_id ASC, wallet ASC
      `,
          {
            wallets: account.wallets,
            contracts: [
              MEMES_CONTRACT.toLowerCase(),
              GRADIENT_CONTRACT.toLowerCase()
            ]
          },
          options
        );
        const pebbles = await this.getDb().execute<{
          token_id: string;
          wallet: string;
        }>(
          `
        SELECT CAST(id AS CHAR) AS token_id, LOWER(owner) AS wallet FROM ${NEXTGEN_TOKENS_TABLE}
        WHERE collection_id = 1 AND owner IN (:wallets) AND pending = false AND burnt = false ORDER BY id ASC
      `,
          { wallets: account.wallets },
          options
        );
        const snapshots = await this.getDb().execute<{
          block_number: number;
          nextgen_block_number: number | null;
        }>(
          `
        SELECT block_reference AS block_number,
          (SELECT MAX(block) FROM ${NEXTGEN_BLOCKS_TABLE}) AS nextgen_block_number
        FROM ${NFT_OWNERS_SYNC_STATE_TABLE} WHERE id = 1
      `,
          undefined,
          options
        );
        if (!snapshots[0] || Number(snapshots[0].block_number) <= 0)
          throw new CustomApiCompliantException(
            503,
            'Holdings snapshot is not available'
          );
        const combined: CollectingHolding[] = holdings.map((row) => ({
          asset_key: collectingAssetKey(row.contract, row.token_id),
          wallet: row.wallet,
          quantity: row.quantity
        }));
        combined.push(
          ...pebbles.map((row) => ({
            asset_key: collectingAssetKey(
              COLLECTING_PEBBLES_CONTRACT,
              row.token_id
            ),
            wallet: row.wallet,
            quantity: '1'
          }))
        );
        combined.sort(
          (a, b) =>
            a.asset_key.localeCompare(b.asset_key) ||
            a.wallet.localeCompare(b.wallet)
        );
        return {
          account,
          holdings: combined,
          snapshot: {
            block_number: Number(snapshots[0].block_number),
            nextgen_block_number:
              snapshots[0].nextgen_block_number === null
                ? null
                : Number(snapshots[0].nextgen_block_number)
          }
        };
      }
    );
  }

  async readTdhProjectionSource(profileId: string): Promise<{
    account: CollectingAccount;
    input: CollectingTdhProjectionInput;
    official: CollectingOfficialTdh;
  }> {
    return this.getDb().executeNativeQueriesInTransaction(
      async (connection) => {
        const account = await this.readAccount(profileId, connection);
        const db = this.getDb();
        const options = { wrappedConnection: connection };
        const snapshots = await db.execute<SnapshotRow>(
          `SELECT block_number, timestamp AS block_timestamp FROM ${TDH_BLOCKS_TABLE} ORDER BY block_number DESC LIMIT 1`,
          undefined,
          options
        );
        const snapshot = snapshots[0];
        if (!snapshot)
          throw new CustomApiCompliantException(
            503,
            'Official TDH snapshot is not available'
          );
        const at = new Date(snapshot.block_timestamp).toISOString();
        const officialRows = await db.execute<{
          tdh: number;
          boosted_tdh: number;
          boost: number;
          memes_cards_sets: number;
          wallets: unknown;
          memes: unknown;
          gradients: unknown;
          nextgen: unknown;
        }>(
          `SELECT tdh, boosted_tdh, boost, memes_cards_sets, wallets, memes, gradients, nextgen FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} WHERE block = :block AND consolidation_key = :key LIMIT 1`,
          { block: snapshot.block_number, key: account.consolidation_key },
          options
        );
        const official = officialRows[0];
        if (!official)
          throw new CustomApiCompliantException(
            503,
            'The account has not been included in the official TDH snapshot'
          );
        const officialWallets: unknown =
          typeof official.wallets === 'string'
            ? JSON.parse(official.wallets)
            : official.wallets;
        if (
          !Array.isArray(officialWallets) ||
          officialWallets.some((wallet) => typeof wallet !== 'string') ||
          collectingHash(
            officialWallets
              .map((wallet: string) => wallet.toLowerCase())
              .sort((a, b) => a.localeCompare(b))
          ) !== collectingHash(account.wallets)
        ) {
          throw new CustomApiCompliantException(
            503,
            'Account membership differs from the official TDH snapshot'
          );
        }
        const nfts = bounded(
          await db.execute<{
            id: number;
            contract: string;
            supply: number;
            edition_size_floor: number | null;
            mint_date: string;
            hodl_rate: number;
          }>(
            `SELECT id, contract, supply, edition_size_floor, mint_date, hodl_rate FROM ${NFTS_TABLE} WHERE contract IN (:contracts) AND mint_date <= :at ORDER BY contract ASC, id ASC LIMIT ${MAX_CATALOG_ASSETS + 1}`,
            {
              contracts: [MEMES_CONTRACT, GRADIENT_CONTRACT],
              at: new Date(at)
            },
            options
          ),
          MAX_CATALOG_ASSETS
        );
        const mintCounts = bounded(
          await db.execute<{ token_id: number; supply: number }>(
            `SELECT token_id, SUM(token_count) AS supply FROM ${TRANSACTIONS_TABLE} WHERE contract = :contract AND from_address = :zero AND block <= :block GROUP BY token_id ORDER BY token_id ASC LIMIT ${MAX_CATALOG_ASSETS + 1}`,
            {
              contract: MEMES_CONTRACT,
              zero: NULL_ADDRESS,
              block: snapshot.block_number
            },
            options
          ),
          MAX_CATALOG_ASSETS
        );
        const supply: Record<number, number> = {};
        mintCounts.forEach((row) => {
          supply[Number(row.token_id)] = Number(row.supply);
        });
        if (supply[8] !== undefined)
          supply[8] += MEME_8_EDITION_BURN_ADJUSTMENT;
        const calculationSizes = buildMemeCalculationEditionSizes(
          nfts.map((nft) => ({
            ...nft,
            edition_size_floor: Number(nft.edition_size_floor ?? 0)
          })),
          supply
        );
        const tokens: CollectingProjectionToken[] = nfts.map((nft) => ({
          contract: nft.contract.toLowerCase(),
          token_id: Number(nft.id),
          family:
            nft.contract.toLowerCase() === MEMES_CONTRACT.toLowerCase()
              ? 'memes'
              : 'gradients',
          minted_at: new Date(nft.mint_date).toISOString(),
          hodl_rate: Number(nft.hodl_rate),
          ...(nft.contract.toLowerCase() === MEMES_CONTRACT.toLowerCase()
            ? { calculation_edition_size: calculationSizes[nft.id] }
            : {})
        }));
        const pebbles = bounded(
          await db.execute<{
            id: number;
            mint_date: string;
            hodl_rate: number;
          }>(
            `SELECT id, mint_date, hodl_rate FROM ${NEXTGEN_TOKENS_TABLE} WHERE collection_id = 1 AND mint_date <= :at ORDER BY id ASC LIMIT ${MAX_CATALOG_ASSETS + 1}`,
            { at: new Date(at) },
            options
          ),
          MAX_CATALOG_ASSETS
        );
        tokens.push(
          ...pebbles.map((pebble) => ({
            contract: COLLECTING_PEBBLES_CONTRACT,
            token_id: Number(pebble.id),
            family: 'pebbles' as const,
            minted_at: new Date(pebble.mint_date).toISOString(),
            hodl_rate: Number(pebble.hodl_rate)
          }))
        );
        bounded(tokens, MAX_CATALOG_ASSETS);
        const seasons = await db.execute<MemesSeason>(
          `SELECT id, start_index, end_index, count, name, display, boost FROM ${MEMES_SEASONS_TABLE} ORDER BY id ASC`,
          undefined,
          options
        );
        const transactions = bounded(
          await db.execute<Transaction>(
            `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE block <= :block AND contract IN (:contracts) AND (from_address IN (:wallets) OR to_address IN (:wallets)) ORDER BY transaction_date ASC, transaction ASC, token_id ASC LIMIT 100001`,
            {
              block: snapshot.block_number,
              contracts: [
                MEMES_CONTRACT,
                GRADIENT_CONTRACT,
                COLLECTING_PEBBLES_CONTRACT
              ],
              wallets: account.wallets
            },
            options
          ),
          100000
        );
        return {
          account,
          input: {
            snapshot_block: Number(snapshot.block_number),
            snapshot_timestamp: at,
            rules_version: 'canonical-tdh-snapshot-v1',
            wallets: account.wallets,
            tokens,
            seasons,
            transactions,
            evaluated_at: at,
            transfers: []
          },
          official: {
            base_tdh: Number(official.tdh),
            boosted_tdh: Number(official.boosted_tdh),
            boost: Number(official.boost),
            full_memes_sets: Number(official.memes_cards_sets),
            tokens: officialTokens(
              official.memes,
              MEMES_CONTRACT,
              'memes',
              Number(official.boost)
            ).concat(
              officialTokens(
                official.gradients,
                GRADIENT_CONTRACT,
                'gradients',
                Number(official.boost)
              ),
              officialTokens(
                official.nextgen,
                COLLECTING_PEBBLES_CONTRACT,
                'pebbles',
                Number(official.boost)
              )
            )
          }
        };
      }
    );
  }

  private async readAccount(
    profileId: string,
    connection: ConnectionWrapper<unknown>
  ): Promise<CollectingAccount> {
    if (!profileId || profileId.length > 100)
      throw new BadRequestException('Invalid profile ID');
    const options = { wrappedConnection: connection };
    const identities = await this.getDb().execute<{
      profile_id: string;
      consolidation_key: string;
    }>(
      `SELECT profile_id, consolidation_key FROM ${IDENTITIES_TABLE} WHERE profile_id = :profileId LIMIT 2`,
      { profileId },
      options
    );
    if (!identities.length)
      throw new NotFoundException('Collecting profile not found');
    if (identities.length !== 1)
      throw new CustomApiCompliantException(
        503,
        'Account membership is ambiguous'
      );
    const identity = identities[0];
    const members = await this.getDb().execute<{ address: string }>(
      `SELECT address FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE consolidation_key = :key ORDER BY address ASC`,
      { key: identity.consolidation_key },
      options
    );
    const wallets = members
      .map((member) => member.address.toLowerCase())
      .sort((a, b) => a.localeCompare(b));
    const expected = identity.consolidation_key
      .split('-')
      .map((wallet) => wallet.toLowerCase())
      .sort((a, b) => a.localeCompare(b));
    if (!wallets.length || collectingHash(wallets) !== collectingHash(expected))
      throw new CustomApiCompliantException(
        503,
        'Account membership is updating'
      );
    return {
      ...identity,
      wallets,
      membership_hash: collectingHash({
        profile_id: profileId,
        consolidation_key: identity.consolidation_key,
        wallets
      })
    };
  }
}

export const collectingDb = new CollectingDb(dbSupplier);
