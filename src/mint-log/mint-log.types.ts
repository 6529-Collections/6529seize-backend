/**
 * The mint log: every write to the minting tables (distributions, merkle
 * trees, claims, claim actions, card mappings and the subscription phase
 * columns) becomes one entry. An entry names the actor's signed intent and
 * carries the exact row changes the write made, so the tables can be rebuilt
 * from empty by replaying the log in order.
 */

export const MINT_LOG_LANE = 'mint';

/**
 * The log keeps one sequence per chain. Tokens and NextGen collections are
 * one chain; collaborations, whose writes run inside drop and decision
 * transactions, are another; rememes and published files a third. A write
 * locks only its own chain's head, so a claim build (which locks decision
 * rows) and a decision that freezes a collaboration never wait on each other.
 */
export type MintLogChain = 'mint' | 'collab' | 'rememes';
export const MINT_LOG_ENTRY_VERSION = 1;

export type MintLogKind =
  | 'mint.genesis'
  | 'claim.built'
  | 'claim.edit'
  | 'claim.media-request'
  | 'claim.media'
  | 'claim.action'
  | 'dist.phase'
  | 'dist.public'
  | 'dist.reset'
  | 'dist.airdrops'
  | 'dist.normalize'
  | 'dist.photos'
  | 'card.published'
  | 'nextgen.allowlist'
  | 'nextgen.burn'
  | 'rememe.add'
  | 'collab.invite'
  | 'collab.respond'
  | 'collab.artwork'
  | 'collab.freeze'
  | 'collab.close'
  | 'publication.receipt';

/**
 * One card's slice of a table. A NextGen collection is a card too, with the
 * contract `nextgen` and its collection id; only the nextgen parts apply to it.
 */
export type MintRowPart =
  | 'distribution'
  | 'normalized'
  | 'photos'
  | 'claim'
  | 'claim_actions'
  | 'card_mapping'
  | 'subscription_phases'
  | 'subscription_phases_identity'
  | 'nextgen_allowlists'
  | 'nextgen_allowlist_rows'
  | 'nextgen_allowlist_burn_rows'
  | 'nextgen_burn_collection'
  | 'rememes'
  | 'collaboration'
  | 'collaboration_invitations'
  | 'rememe_uploads'
  | 'royalties_uploads';

export type MintPart = MintRowPart | 'merkle';

export const MINT_ROW_PARTS: readonly MintRowPart[] = [
  'distribution',
  'normalized',
  'photos',
  'claim',
  'claim_actions',
  'card_mapping',
  'subscription_phases',
  'subscription_phases_identity',
  'nextgen_allowlists',
  'nextgen_allowlist_rows',
  'nextgen_allowlist_burn_rows',
  'nextgen_burn_collection',
  'rememes',
  'collaboration',
  'collaboration_invitations',
  'rememe_uploads',
  'royalties_uploads'
];

/** The card ref contracts of the scopes that are not tokens. */
export const NEXTGEN_CARD_CONTRACT = 'nextgen';
export const REMEMES_CARD_CONTRACT = 'rememes';
export const COLLAB_CARD_CONTRACT = 'collab';
export const UPLOADS_CARD_CONTRACT = 'uploads';

export const MINT_PARTS: readonly MintPart[] = [...MINT_ROW_PARTS, 'merkle'];

export interface MintCardRef {
  /**
   * Lowercase contract address, or the name of a scope that is not a token:
   * `nextgen` (a NextGen collection), `rememes` (one rememe contract),
   * `collab` (one artwork's collaboration), `uploads` (published files).
   */
  readonly contract: string;
  readonly card_id: number;
  /** The scope's key when it is not a number: a rememe contract, a drop id, a table. */
  readonly key?: string;
}

/**
 * A row as captured: column name to a JSON value. Dates, JSON columns, bigints
 * and decimals are strings in a fixed form (see mint-log-columns.ts).
 */
export type MintRow = Readonly<Record<string, string | number | null>>;

export interface MintRowDiff {
  /** Rows that are new or changed, whole. */
  readonly upsert: MintRow[];
  /** Key columns of rows that are gone. */
  readonly delete: MintRow[];
}

/**
 * One merkle root of a card phase. The proofs are not stored: they follow from
 * the allowlist (address and leaf count), which `computeAllowlistMerkle`
 * turns back into the same tree. `raw_proofs` is kept only when that recompute
 * does not reproduce the stored proofs exactly.
 */
export interface MintMerkleRoot {
  readonly row: MintRow;
  readonly allowlist: Array<[string, number]>;
  readonly raw_proofs: Array<[string, string]> | null;
}

export interface MintMerkleDiff {
  readonly upsert: MintMerkleRoot[];
  /** Phases whose root is gone. */
  readonly delete: string[];
}

export type MintCardEffects = {
  readonly [P in MintRowPart]?: MintRowDiff;
} & {
  readonly merkle?: MintMerkleDiff;
};

/** Everything the minting tables hold for one card. */
export type MintCardState = {
  readonly [P in MintRowPart]: MintRow[];
} & {
  readonly merkle: MintMerkleRoot[];
};

export type MintActorType = 'admin' | 'user' | 'service';

export interface MintLogActor {
  readonly type: MintActorType;
  /** The wallet the request was authenticated as, lowercase. */
  readonly wallet: string | null;
  /** The rule that let the wallet act, for example `env:DISTRIBUTION_ADMIN_WALLETS`. */
  readonly authority: string | null;
}

export interface MintLogChecks {
  /** Parts that changed although the kind does not declare them. */
  readonly undeclared: MintPart[];
  /** Merkle phases kept as raw proofs because the recompute differed. */
  readonly merkle_raw: string[];
  /**
   * The replay check: the entry applied over the captured state inside a
   * rolled-back savepoint gave exactly the captured rows ('match'), or not.
   */
  readonly replay: 'match' | 'mismatch' | 'skipped' | 'aborted';
  readonly replay_mismatches: string[];
}

/** The service entry appended to the record log for each write. */
export interface MintLogEntryBody {
  readonly v: typeof MINT_LOG_ENTRY_VERSION;
  readonly kind: MintLogKind;
  readonly chain: MintLogChain;
  /** The chain's sequence, gap-free from its first entry (0). */
  readonly seq: number;
  /** sha256 of the chain's previous entry's canonical JSON, or null for seq 0. */
  readonly prev: string | null;
  readonly at: number;
  readonly card: MintCardRef | null;
  readonly actor: MintLogActor;
  /** The id of the signed record that carried the intent, when there was one. */
  readonly record_id: string | null;
  /** What was asked: route parameters and the request body. */
  readonly intent: Record<string, unknown>;
  /** What the result was computed from (blocks, ids of external inputs). */
  readonly inputs: Record<string, unknown>;
  /** What the writer reported, for writes whose result is not in a table. */
  readonly outputs: Record<string, unknown> | null;
  readonly effects: MintCardEffects;
  readonly checks: MintLogChecks;
  /** The writer threw after changing rows; the effects still hold its changes. */
  readonly writer_error: string | null;
}

/** The parts each kind may change. Anything else is reported as undeclared. */
export const MINT_KIND_PARTS: Readonly<
  Record<MintLogKind, readonly MintPart[]>
> = {
  'mint.genesis': MINT_PARTS,
  'claim.built': ['claim', 'card_mapping', 'distribution'],
  'claim.edit': ['claim', 'distribution'],
  'claim.media-request': [],
  'claim.media': ['claim'],
  'claim.action': ['claim_actions'],
  'dist.phase': [
    'distribution',
    'merkle',
    'subscription_phases',
    'subscription_phases_identity'
  ],
  'dist.public': ['subscription_phases', 'subscription_phases_identity'],
  'dist.reset': [
    'distribution',
    'merkle',
    'normalized',
    'subscription_phases',
    'subscription_phases_identity'
  ],
  'dist.airdrops': ['distribution'],
  'dist.normalize': ['normalized'],
  'dist.photos': ['photos'],
  'card.published': [],
  'nextgen.allowlist': [
    'nextgen_allowlists',
    'nextgen_allowlist_rows',
    'nextgen_allowlist_burn_rows'
  ],
  'nextgen.burn': ['nextgen_burn_collection'],
  'rememe.add': ['rememes'],
  'collab.invite': ['collaboration', 'collaboration_invitations'],
  'collab.respond': ['collaboration_invitations'],
  'collab.artwork': ['collaboration'],
  'collab.freeze': ['collaboration', 'collaboration_invitations'],
  'collab.close': ['collaboration', 'collaboration_invitations'],
  'publication.receipt': ['rememe_uploads', 'royalties_uploads']
};

/** The chain each kind's writes belong to (the genesis names its own). */
export const MINT_KIND_CHAIN: Readonly<Record<MintLogKind, MintLogChain>> = {
  'mint.genesis': 'mint',
  'claim.built': 'mint',
  'claim.edit': 'mint',
  'claim.media-request': 'mint',
  'claim.media': 'mint',
  'claim.action': 'mint',
  'dist.phase': 'mint',
  'dist.public': 'mint',
  'dist.reset': 'mint',
  'dist.airdrops': 'mint',
  'dist.normalize': 'mint',
  'dist.photos': 'mint',
  'card.published': 'mint',
  'nextgen.allowlist': 'mint',
  'nextgen.burn': 'mint',
  'rememe.add': 'rememes',
  'collab.invite': 'collab',
  'collab.respond': 'collab',
  'collab.artwork': 'collab',
  'collab.freeze': 'collab',
  'collab.close': 'collab',
  'publication.receipt': 'rememes'
};

/** The chain whose genesis holds a card's state. */
export function chainOfCard(card: MintCardRef): MintLogChain {
  if (card.contract === COLLAB_CARD_CONTRACT) return 'collab';
  if (
    card.contract === REMEMES_CARD_CONTRACT ||
    card.contract === UPLOADS_CARD_CONTRACT
  ) {
    return 'rememes';
  }
  return 'mint';
}
