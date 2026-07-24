import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  FilterDirection,
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy,
  UserGroupEntity
} from '@/entities/IUserGroup';
import { IdentityEntity } from '@/entities/IIdentity';
import { RateMatter, Rating } from '@/entities/IRating';
import { WaveEntity } from '@/entities/IWave';
import {
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { NEXTGEN_CORE_CONTRACT } from '@/nextgen/nextgen_constants';
import { Network } from '@/alchemy-sdk';
import { consolidationTools } from '@/consolidation-tools';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import { aUserGroup } from '@/tests/fixtures/user-group.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import {
  EligibilityConformanceVector,
  VectorCollection,
  VectorGroup
} from './vector-types';

const VECTORS_DIR = path.join(__dirname, 'vectors');

const COLLECTION_CONTRACTS: Record<VectorCollection, string> = {
  memes: MEMES_CONTRACT,
  gradient: GRADIENT_CONTRACT,
  lab: MEMELAB_CONTRACT,
  nextgen: NEXTGEN_CORE_CONTRACT[Network.ETH_MAINNET]
};

export interface MaterializedGrant {
  readonly id: string;
  readonly tokensetId: string;
  readonly partition: string;
  readonly tokenMode: 'ALL' | 'INCLUDE';
  readonly status: string;
  readonly tokens: string[];
}

export interface NftOwnerRow {
  readonly wallet: string;
  readonly contract: string;
  readonly token_id: number;
  readonly balance: number;
  readonly block_reference: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ExternalOwnershipRow {
  readonly partition: string;
  readonly token_id: string;
  readonly owner: string;
  readonly since_block: number;
  readonly since_time: number;
  readonly sale_epoch_start_block: null;
  readonly sale_epoch_tx: null;
  readonly free_transfers_since_epoch: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface XtdhGrantRow {
  readonly id: string;
  readonly tokenset_id: string;
  readonly replaced_grant_id: null;
  readonly grantor_id: string;
  readonly target_chain: number;
  readonly target_contract: string;
  readonly target_partition: string;
  readonly token_mode: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly valid_from: number;
  readonly valid_to: null;
  readonly rate: number;
  readonly status: string;
  readonly error_details: null;
  readonly is_irrevocable: boolean;
}

export interface XtdhGrantTokenRow {
  readonly tokenset_id: string;
  readonly token_id: string;
  readonly target_partition: string;
}

export interface MaterializedVector {
  readonly raw: EligibilityConformanceVector;
  readonly name: string;
  readonly dimension: string;
  readonly subjectProfileId: string;
  readonly identityRows: IdentityEntity[];
  readonly ackRows: { address: string; consolidation_key: string }[];
  readonly walletsByIdentitySym: Record<string, string[]>;
  readonly profileIdBySym: Record<string, string>;
  readonly groupEntities: UserGroupEntity[];
  readonly groupIdBySym: Record<string, string>;
  readonly profileGroupRows: { profile_group_id: string; profile_id: string }[];
  readonly ratingRows: Rating[];
  readonly nftOwnerRows: NftOwnerRow[];
  readonly grantRows: XtdhGrantRow[];
  readonly grantTokenRows: XtdhGrantTokenRow[];
  readonly grantsById: Record<string, MaterializedGrant>;
  readonly externalOwnershipRows: ExternalOwnershipRow[];
  readonly waveRows: WaveEntity[];
  readonly expectedEligibleGroupIds: string[];
}

function aRandomWallet(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

function readVectorFiles(): EligibilityConformanceVector[] {
  const files = fs
    .readdirSync(VECTORS_DIR)
    .filter((it) => it.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));
  const vectors = files.flatMap((file) => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(VECTORS_DIR, file), 'utf8')
    ) as EligibilityConformanceVector[];
    if (!Array.isArray(parsed)) {
      throw new TypeError(
        `Vector file ${file} must contain an array of vectors`
      );
    }
    return parsed;
  });
  const names = new Set<string>();
  for (const vector of vectors) {
    if (names.has(vector.name)) {
      throw new TypeError(`Duplicate vector name: ${vector.name}`);
    }
    names.add(vector.name);
  }
  return vectors;
}

function resolveOrThrow(
  mapping: Record<string, string>,
  sym: string | null | undefined,
  kind: string,
  vectorName: string
): string | null {
  if (sym === null || sym === undefined) {
    return null;
  }
  const resolved = mapping[sym];
  if (!resolved) {
    throw new Error(`Vector ${vectorName} references unknown ${kind} "${sym}"`);
  }
  return resolved;
}

function toJsonTokensOrNull(
  tokens: string[] | null | undefined
): string | null {
  if (tokens === null || tokens === undefined) {
    return null;
  }
  return JSON.stringify(tokens);
}

function toMatchMode(
  mode: string | undefined,
  fallback: GroupNftOwnershipMatchMode
): GroupNftOwnershipMatchMode {
  return mode ? (mode as GroupNftOwnershipMatchMode) : fallback;
}

function materializeGroup(
  vector: EligibilityConformanceVector,
  group: VectorGroup,
  ids: {
    groupIdBySym: Record<string, string>;
    profileIdBySym: Record<string, string>;
    profileGroupIdBySym: Record<string, string>;
    grantIdBySym: Record<string, string>;
  }
): UserGroupEntity {
  return aUserGroup(
    {
      visible: group.visible ?? true,
      is_direct_message: false,
      tdh_min: group.tdh_min ?? null,
      tdh_max: group.tdh_max ?? null,
      tdh_inclusion_strategy: (group.tdh_inclusion_strategy ??
        GroupTdhInclusionStrategy.TDH) as GroupTdhInclusionStrategy,
      level_min: group.level_min ?? null,
      level_max: group.level_max ?? null,
      rep_min: group.rep_min ?? null,
      rep_max: group.rep_max ?? null,
      rep_user: resolveOrThrow(
        ids.profileIdBySym,
        group.rep_user,
        'identity',
        vector.name
      ),
      rep_direction: (group.rep_direction ?? null) as FilterDirection | null,
      rep_category: group.rep_category ?? null,
      cic_min: group.cic_min ?? null,
      cic_max: group.cic_max ?? null,
      cic_user: resolveOrThrow(
        ids.profileIdBySym,
        group.cic_user,
        'identity',
        vector.name
      ),
      cic_direction: (group.cic_direction ?? null) as FilterDirection | null,
      owns_meme: group.owns_meme ?? false,
      owns_meme_tokens: toJsonTokensOrNull(group.owns_meme_tokens),
      owns_meme_tokens_match_mode: toMatchMode(
        group.owns_meme_tokens_match_mode,
        GroupNftOwnershipMatchMode.ALL_TOKENS
      ),
      owns_gradient: group.owns_gradient ?? false,
      owns_gradient_tokens: toJsonTokensOrNull(group.owns_gradient_tokens),
      owns_gradient_tokens_match_mode: toMatchMode(
        group.owns_gradient_tokens_match_mode,
        GroupNftOwnershipMatchMode.ALL_TOKENS
      ),
      owns_lab: group.owns_lab ?? false,
      owns_lab_tokens: toJsonTokensOrNull(group.owns_lab_tokens),
      owns_lab_tokens_match_mode: toMatchMode(
        group.owns_lab_tokens_match_mode,
        GroupNftOwnershipMatchMode.ALL_TOKENS
      ),
      owns_nextgen: group.owns_nextgen ?? false,
      owns_nextgen_tokens: toJsonTokensOrNull(group.owns_nextgen_tokens),
      owns_nextgen_tokens_match_mode: toMatchMode(
        group.owns_nextgen_tokens_match_mode,
        GroupNftOwnershipMatchMode.ALL_TOKENS
      ),
      profile_group_id: resolveOrThrow(
        ids.profileGroupIdBySym,
        group.profile_group_id,
        'profile group',
        vector.name
      ),
      excluded_profile_group_id: resolveOrThrow(
        ids.profileGroupIdBySym,
        group.excluded_profile_group_id,
        'profile group',
        vector.name
      ),
      is_beneficiary_of_grant_id: resolveOrThrow(
        ids.grantIdBySym,
        group.is_beneficiary_of_grant_id,
        'grant',
        vector.name
      ),
      is_beneficiary_of_grant_match_mode:
        (group.is_beneficiary_of_grant_match_mode ??
          GroupBeneficiaryGrantMatchMode.ANY_TOKEN) as GroupBeneficiaryGrantMatchMode
    },
    {
      id: ids.groupIdBySym[group.id],
      name: `${vector.name}/${group.id}`
    }
  );
}

function materializeIdentities(vector: EligibilityConformanceVector): {
  identityRows: IdentityEntity[];
  ackRows: { address: string; consolidation_key: string }[];
  walletsByIdentitySym: Record<string, string[]>;
  profileIdBySym: Record<string, string>;
} {
  const identityRows: IdentityEntity[] = [];
  const ackRows: { address: string; consolidation_key: string }[] = [];
  const walletsByIdentitySym: Record<string, string[]> = {};
  const profileIdBySym: Record<string, string> = {};
  for (const identity of vector.identities) {
    const walletCount = 1 + (identity.extra_wallets ?? 0);
    const wallets = Array.from({ length: walletCount }, () => aRandomWallet());
    const consolidationKey = consolidationTools.buildConsolidationKey(wallets);
    const profileId = randomUUID();
    identityRows.push(
      anIdentity(
        {
          tdh: identity.tdh ?? 0,
          xtdh: identity.xtdh ?? 0,
          level_raw: identity.level_raw ?? 0,
          rep: identity.rep ?? 0,
          cic: identity.cic ?? 0
        },
        {
          consolidation_key: consolidationKey,
          profile_id: profileId,
          primary_address: wallets[0],
          handle: `id-${wallets[0]}`
        }
      )
    );
    for (const wallet of wallets) {
      ackRows.push({ address: wallet, consolidation_key: consolidationKey });
    }
    walletsByIdentitySym[identity.id] = wallets;
    profileIdBySym[identity.id] = profileId;
  }
  return { identityRows, ackRows, walletsByIdentitySym, profileIdBySym };
}

function materializeGrants(
  vector: EligibilityConformanceVector,
  grantorProfileId: string
): {
  grantRows: XtdhGrantRow[];
  grantTokenRows: XtdhGrantTokenRow[];
  grantsById: Record<string, MaterializedGrant>;
  grantIdBySym: Record<string, string>;
} {
  const grantRows: XtdhGrantRow[] = [];
  const grantTokenRows: XtdhGrantTokenRow[] = [];
  const grantsById: Record<string, MaterializedGrant> = {};
  const grantIdBySym: Record<string, string> = {};
  for (const grant of vector.grants ?? []) {
    const grantId = randomUUID();
    const tokensetId = randomUUID();
    const contract = aRandomWallet();
    const partition = `1:${contract}`;
    const status = grant.status ?? 'GRANTED';
    grantRows.push({
      id: grantId,
      tokenset_id: tokensetId,
      replaced_grant_id: null,
      grantor_id: grantorProfileId,
      target_chain: 1,
      target_contract: contract,
      target_partition: partition,
      token_mode: grant.token_mode,
      created_at: 0,
      updated_at: 0,
      valid_from: 0,
      valid_to: null,
      rate: 1,
      status,
      error_details: null,
      is_irrevocable: false
    });
    for (const tokenId of grant.tokens ?? []) {
      grantTokenRows.push({
        tokenset_id: tokensetId,
        token_id: tokenId,
        target_partition: partition
      });
    }
    grantsById[grantId] = {
      id: grantId,
      tokensetId,
      partition,
      tokenMode: grant.token_mode,
      status,
      tokens: grant.tokens ?? []
    };
    grantIdBySym[grant.id] = grantId;
  }
  return { grantRows, grantTokenRows, grantsById, grantIdBySym };
}

function materializeVector(
  vector: EligibilityConformanceVector
): MaterializedVector {
  const { identityRows, ackRows, walletsByIdentitySym, profileIdBySym } =
    materializeIdentities(vector);
  const subjectProfileId = profileIdBySym[vector.subject];
  if (!subjectProfileId) {
    throw new Error(
      `Vector ${vector.name} subject "${vector.subject}" is not among its identities`
    );
  }

  const profileGroupIdBySym: Record<string, string> = {};
  const profileGroupRows: { profile_group_id: string; profile_id: string }[] =
    [];
  for (const profileGroup of vector.profile_groups ?? []) {
    const profileGroupId = randomUUID();
    profileGroupIdBySym[profileGroup.id] = profileGroupId;
    for (const member of profileGroup.members) {
      profileGroupRows.push({
        profile_group_id: profileGroupId,
        profile_id: resolveOrThrow(
          profileIdBySym,
          member,
          'identity',
          vector.name
        )!
      });
    }
  }

  const { grantRows, grantTokenRows, grantsById, grantIdBySym } =
    materializeGrants(vector, subjectProfileId);

  const externalOwnershipRows: ExternalOwnershipRow[] = (
    vector.external_ownership ?? []
  ).map((ownership) => {
    const grantId = resolveOrThrow(
      grantIdBySym,
      ownership.grant,
      'grant',
      vector.name
    )!;
    const ownerWallet = walletsByIdentitySym[ownership.owner]?.[0];
    if (!ownerWallet) {
      throw new Error(
        `Vector ${vector.name} external ownership references unknown wallet of "${ownership.owner}"`
      );
    }
    return {
      partition: grantsById[grantId].partition,
      token_id: ownership.token_id,
      owner: ownerWallet,
      since_block: 1,
      since_time: 1,
      sale_epoch_start_block: null,
      sale_epoch_tx: null,
      free_transfers_since_epoch: 0,
      created_at: 0,
      updated_at: 0
    };
  });

  const ratingRows: Rating[] = (vector.ratings ?? []).map((rating) => {
    const category =
      rating.category ?? (rating.matter === 'CIC' ? 'CIC' : null);
    if (category === null) {
      throw new Error(
        `Vector ${vector.name} has a ${rating.matter} rating without a category`
      );
    }
    return {
      rater_profile_id: resolveOrThrow(
        profileIdBySym,
        rating.rater,
        'identity',
        vector.name
      )!,
      matter_target_id: resolveOrThrow(
        profileIdBySym,
        rating.target,
        'identity',
        vector.name
      )!,
      matter: rating.matter as RateMatter,
      matter_category: category,
      rating: rating.rating,
      last_modified: new Date('2024-01-01T00:00:00Z')
    };
  });

  const nftOwnerRows: NftOwnerRow[] = (vector.nft_ownings ?? []).map(
    (owning) => {
      const wallets = walletsByIdentitySym[owning.owner];
      const wallet = wallets?.[owning.wallet_index ?? 0];
      if (!wallet) {
        throw new Error(
          `Vector ${vector.name} nft owning references unknown wallet of "${owning.owner}"`
        );
      }
      return {
        wallet,
        contract: COLLECTION_CONTRACTS[owning.collection],
        token_id: Number(owning.token_id),
        balance: 1,
        block_reference: 1,
        created_at: new Date(0),
        updated_at: new Date(0)
      };
    }
  );

  const groupIdBySym: Record<string, string> = {};
  for (const group of vector.groups) {
    groupIdBySym[group.id] = `${vector.name}--${group.id}`;
  }
  const groupEntities = vector.groups.map((group) =>
    materializeGroup(vector, group, {
      groupIdBySym,
      profileIdBySym,
      profileGroupIdBySym,
      grantIdBySym
    })
  );
  const waveRows = groupEntities.map((group) =>
    aWave({ visibility_group_id: group.id })
  );

  const expectedEligibleGroupIds = vector.expected.eligible_group_ids.map(
    (sym) => resolveOrThrow(groupIdBySym, sym, 'group', vector.name)!
  );
  return {
    raw: vector,
    name: vector.name,
    dimension: vector.dimension,
    subjectProfileId,
    identityRows,
    ackRows,
    walletsByIdentitySym,
    profileIdBySym,
    groupEntities,
    groupIdBySym,
    profileGroupRows,
    ratingRows,
    nftOwnerRows,
    grantRows,
    grantTokenRows,
    grantsById,
    externalOwnershipRows,
    waveRows,
    expectedEligibleGroupIds
  };
}

let cachedVectors: MaterializedVector[] | null = null;

export function loadMaterializedVectors(): MaterializedVector[] {
  cachedVectors ??= readVectorFiles().map((vector) =>
    materializeVector(vector)
  );
  return cachedVectors;
}
