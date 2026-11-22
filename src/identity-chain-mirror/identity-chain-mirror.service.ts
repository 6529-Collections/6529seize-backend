import { MAX_STORABLE_DELEGATION_TOKEN_ID } from '@/delegation-row';
import {
  ChainGatewayClient,
  ChainGatewayError,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainDelegation,
  ChainFeedRecord,
  ChainIdentity,
  ChainRating
} from '@/chain-gateway/chain-gateway.types';
import { Logger } from '@/logging';
import {
  DelegationRowWrite,
  identityChainMirrorDb,
  IdentityChainMirrorDb,
  MirrorState,
  RatingRowWrite
} from './identity-chain-mirror.db';
import {
  CHAIN_BLOCK_BASE,
  ChainIdentityView,
  consolidationKeyOf,
  NEVER_EXPIRES,
  planIdentity,
  principalProfileId
} from './identity-plan';
import {
  decodeProfileDoc,
  ProfileDocFields,
  toProfileDocFields
} from './profile-doc';

const logger = Logger.get('IDENTITY_CHAIN_MIRROR');

/** 6529.io's consolidation keys hold four wallets (varchar 200). */
export const MAX_CONSOLIDATION_KEY_LENGTH = 200;
const FULL_SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
const FEED_PAGE_BLOCKS = 200;
const IDENTITY_PAGE = 200;
const LAST_USE_CASE = 998;
const FEED_GONE_ATTEMPTS = 3;
/** ratings.rating is a signed 32-bit int. */
const MAX_RATING = 2_147_483_647;

type Gateway = Pick<
  ChainGatewayClient,
  | 'getHead'
  | 'getMembership'
  | 'listIdentities'
  | 'getIdentityByPrincipal'
  | 'getIdentitiesByWallets'
  | 'getIdentityByLegacyProfileId'
  | 'getProfileDoc'
  | 'getRatings'
  | 'getDelegations'
  | 'getDelegationsOfWallet'
  | 'getChanges'
>;

export interface MirrorRunReport {
  skipped?: 'import_not_complete';
  mode: 'full_sync' | 'feed' | 'idle';
  identities: number;
  ratingTargets: number;
  delegationWallets: number;
  feedBlocks: number;
  skippedTooManyWallets: string[];
  /** Merged, closing or walletless identities, not written. */
  skippedInactive: string[];
  /** Identities that failed, with why; the rest went on. */
  failed: string[];
  docProblems: string[];
  nextHeight: number | null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX20 = /^0x[0-9a-f]{40}$/;
/** A 32-byte word holding an address: 12 zero bytes, then the address. */
const ADDRESS_WORD = /^0x0{24}([0-9a-f]{40})$/;
const PRINCIPAL_FIELD = /principal|rater|target|holder|identity|merged|^p$/i;

function collectHex(
  fields: Record<string, unknown> | null | undefined,
  principals: Set<string>,
  wallets: Set<string>,
  anyHex32: Set<string>
) {
  if (!fields) return;
  for (const [name, raw] of Object.entries(fields)) {
    if (typeof raw !== 'string') continue;
    const value = raw.toLowerCase();
    const word = ADDRESS_WORD.exec(value);
    if (word) {
      wallets.add(`0x${word[1]}`);
    } else if (HEX32.test(value)) {
      anyHex32.add(value);
      if (PRINCIPAL_FIELD.test(name)) principals.add(value);
    } else if (HEX20.test(value)) {
      wallets.add(value);
    }
  }
}

export interface FeedEffects {
  readonly principals: Set<string>;
  readonly wallets: Set<string>;
  readonly ratingTargets: Set<string>;
  readonly delegationHolders: Set<string>;
}

/**
 * What a page of the change feed touches. Records are read generically:
 * 32-byte ids in principal-like fields are identities, 20-byte values are
 * wallets; rating families mark their principals for a ratings refresh,
 * delegation families their holders for a delegations refresh.
 */
export function feedEffects(records: readonly ChainFeedRecord[]): FeedEffects {
  const effects: FeedEffects = {
    principals: new Set(),
    wallets: new Set(),
    ratingTargets: new Set(),
    delegationHolders: new Set()
  };
  for (const record of records) {
    const principals = new Set<string>();
    const wallets = new Set<string>();
    const anyHex32 = new Set<string>();
    collectHex(record.keyFields, principals, wallets, anyHex32);
    collectHex(record.valueFields ?? undefined, principals, wallets, anyHex32);
    const ids = principals.size ? principals : anyHex32;
    const name = `${record.name ?? ''}`;
    if (/rating/i.test(name)) {
      // A rating moves its target's totals and level too.
      ids.forEach((it) => {
        effects.ratingTargets.add(it);
        effects.principals.add(it);
      });
    } else if (/delegation/i.test(name)) {
      ids.forEach((it) => effects.delegationHolders.add(it));
      wallets.forEach((it) => effects.delegationHolders.add(it));
    } else {
      ids.forEach((it) => effects.principals.add(it));
      wallets.forEach((it) => effects.wallets.add(it));
    }
  }
  return effects;
}

export function toDelegationRow(
  wallet: string,
  record: ChainDelegation
): DelegationRowWrite | null {
  let tokenId = 0;
  if (!record.allTokens) {
    try {
      const big = BigInt(record.tokenId);
      if (big > MAX_STORABLE_DELEGATION_TOKEN_ID) return null;
      tokenId = Number(big);
    } catch {
      return null;
    }
  }
  let expiry = NEVER_EXPIRES;
  try {
    const big = BigInt(record.expiry);
    expiry = big < BigInt(NEVER_EXPIRES) ? Number(big) : NEVER_EXPIRES;
  } catch {
    expiry = NEVER_EXPIRES;
  }
  const block =
    record.source === 'imported' && record.ethBlock
      ? Number(record.ethBlock)
      : CHAIN_BLOCK_BASE + Number(record.setHeight);
  return {
    block,
    from_address: wallet.toLowerCase(),
    to_address: record.delegate.toLowerCase(),
    collection: record.collection.toLowerCase(),
    use_case: Number(record.useCase),
    expiry,
    all_tokens: !!record.allTokens,
    token_id: tokenId
  };
}

/**
 * Of the existing 6529.io profiles of an identity's wallets, the one it
 * takes over: a real handle first, then the anchor wallet's, then the lowest id.
 */
export function pickWalletProfile(
  candidates: { profile_id: string; handle: string; address: string }[],
  anchor: string | null
): string | null {
  const real = (it: { handle: string }) =>
    Number(!it.handle.toLowerCase().startsWith('id-0x'));
  const sorted = [...candidates].sort(
    (a, b) =>
      real(b) - real(a) ||
      Number(b.address === anchor) - Number(a.address === anchor) ||
      compareText(a.profile_id, b.profile_id)
  );
  return sorted[0]?.profile_id ?? null;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Merged, closing or walletless: nothing of it is written. */
export function isInactive(identity: ChainIdentity): boolean {
  return (
    !!identity.mergedInto ||
    !identity.wallets.length ||
    (!!identity.status && identity.status.toLowerCase() !== 'active')
  );
}

function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The identity mirror: keeps 6529.io's identity tables (profiles,
 * identities, address_consolidation_keys, consolidations as confirmed pairs,
 * delegations, REP and CIC ratings, statements, and the rep/cic/level_raw
 * aggregates) equal to the 6529 chain, read through the gateway at finalized
 * heights. A full sync walks every identity, delegation and pair; between
 * full syncs it follows the gateway's change feed. Idempotent: it writes what
 * the chain says, so a run may repeat or overlap another's work safely.
 */
export class IdentityChainMirror {
  private readonly identities = new Map<string, ChainIdentity | null>();

  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly db: IdentityChainMirrorDb = identityChainMirrorDb,
    private readonly now: () => number = () => Date.now()
  ) {}

  private report(): MirrorRunReport {
    return {
      mode: 'idle',
      identities: 0,
      ratingTargets: 0,
      delegationWallets: 0,
      feedBlocks: 0,
      skippedTooManyWallets: [],
      docProblems: [],
      skippedInactive: [],
      failed: [],
      nextHeight: null
    };
  }

  async run({ budgetMs }: { budgetMs: number }): Promise<MirrorRunReport> {
    const deadline = this.now() + budgetMs;
    const report = this.report();
    this.identities.clear();
    const membership = await this.gateway.getMembership();
    const importState = membership?.import as
      | { completed?: boolean }
      | undefined;
    if (!importState?.completed) {
      report.skipped = 'import_not_complete';
      return report;
    }
    let state = (await this.db.getState()) ?? this.emptyState();
    const fullSyncDue =
      state.last_full_sync_at === null ||
      this.now() - Number(state.last_full_sync_at) > FULL_SYNC_EVERY_MS;
    if (!state.sync_phase && (state.next_height === null || fullSyncDue)) {
      state = await this.startFullSync(state);
    }
    if (state.sync_phase) {
      report.mode = 'full_sync';
      state = await this.continueFullSync(state, deadline, report);
    }
    if (!state.sync_phase && state.next_height !== null) {
      if (report.mode === 'idle') report.mode = 'feed';
      state = await this.followFeed(state, deadline, report);
    }
    report.nextHeight = state.next_height;
    return report;
  }

  private emptyState(): MirrorState {
    return {
      next_height: null,
      sync_from_height: null,
      sync_phase: null,
      sync_after: null,
      last_full_sync_at: null
    };
  }

  private async save(state: MirrorState): Promise<MirrorState> {
    await this.db.saveState(state, this.now());
    return state;
  }

  // ---------------------------------------------------------------- full sync

  private async startFullSync(state: MirrorState): Promise<MirrorState> {
    const head = await this.gateway.getHead(true);
    logger.info(`[FULL SYNC FROM HEIGHT ${head.finalizedHeight}]`);
    return await this.save({
      ...state,
      sync_from_height: head.finalizedHeight,
      sync_phase: 'IDENTITIES',
      sync_after: null
    });
  }

  private async continueFullSync(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    while (state.sync_phase === 'IDENTITIES' && this.now() < deadline) {
      const page = await this.gateway.listIdentities({
        after: state.sync_after,
        limit: IDENTITY_PAGE
      });
      for (const identity of page?.items ?? []) {
        await this.isolated(identity.principalId, report, async () => {
          await this.applyIdentity(identity, report);
          await this.syncTargetRatings(identity, report);
        });
      }
      state = await this.save(
        page?.next
          ? { ...state, sync_after: page.next }
          : { ...state, sync_phase: 'DELEGATIONS', sync_after: null }
      );
    }
    if (state.sync_phase === 'DELEGATIONS' && this.now() < deadline) {
      await this.fullSyncDelegations(report);
      state = await this.save({ ...state, sync_phase: 'CONSOLIDATIONS' });
    }
    if (state.sync_phase === 'CONSOLIDATIONS' && this.now() < deadline) {
      await this.fullSyncPairs(state);
      state = await this.save({
        next_height: Number(state.sync_from_height) + 1,
        sync_from_height: null,
        sync_phase: null,
        sync_after: null,
        last_full_sync_at: this.now()
      });
      logger.info(`[FULL SYNC DONE] [NEXT HEIGHT ${state.next_height}]`);
    }
    return state;
  }

  private async allIdentities(): Promise<ChainIdentity[]> {
    const all: ChainIdentity[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await this.gateway.listIdentities({ after, limit: 500 });
      all.push(...(page?.items ?? []));
      if (!page?.next) return all;
      after = page.next;
    }
  }

  private async fullSyncPairs(state: MirrorState) {
    const pairs: { wallet1: string; wallet2: string }[] = [];
    for (const identity of await this.allIdentities()) {
      const wallets = identity.wallets
        .map((it) => it.toLowerCase())
        .sort((a, b) => (a < b ? -1 : Number(a > b)));
      if (consolidationKeyOf(wallets).length > MAX_CONSOLIDATION_KEY_LENGTH) {
        continue;
      }
      for (let i = 0; i < wallets.length; i++) {
        for (let j = i + 1; j < wallets.length; j++) {
          pairs.push({ wallet1: wallets[i], wallet2: wallets[j] });
        }
      }
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceAllPairs(
        pairs,
        CHAIN_BLOCK_BASE + Number(state.sync_from_height),
        this.now(),
        conn
      )
    );
  }

  private async fullSyncDelegations(report: MirrorRunReport) {
    const wanted = new Map<string, DelegationRowWrite[]>();
    const add = (wallet: string, record: ChainDelegation) => {
      const row = toDelegationRow(wallet, record);
      if (!row) return;
      const list = wanted.get(row.from_address) ?? [];
      list.push(row);
      wanted.set(row.from_address, list);
    };
    for (let useCase = 1; useCase <= LAST_USE_CASE; useCase++) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gateway.getDelegations(
          { byUseCase: useCase },
          { after, limit: 1000 }
        );
        for (const record of page?.items ?? []) {
          for (const wallet of await this.walletsOfHolder(record)) {
            add(wallet, record);
          }
        }
        if (!page?.next) break;
        after = page.next;
      }
    }
    const wallets = new Set<string>([
      ...Array.from(wanted.keys()),
      ...(await this.db.walletsWithDelegations())
    ]);
    for (const wallet of Array.from(wallets)) {
      await this.db.executeNativeQueriesInTransaction((conn) =>
        this.db.replaceWalletDelegations(wallet, wanted.get(wallet) ?? [], conn)
      );
      report.delegationWallets++;
    }
  }

  private async walletsOfHolder(record: ChainDelegation): Promise<string[]> {
    if (record.scope === 'wallet') {
      return [record.holder.toLowerCase()];
    }
    const identity = await this.identity(record.holder);
    return identity?.wallets.map((it) => it.toLowerCase()) ?? [];
  }

  // ---------------------------------------------------------------- the feed

  private async followFeed(
    initial: MirrorState,
    deadline: number,
    report: MirrorRunReport
  ): Promise<MirrorState> {
    let state = initial;
    while (this.now() < deadline) {
      const page = await this.feedPage(Number(state.next_height));
      if (!page) {
        logger.warn(
          `[FEED GONE AT ${state.next_height}] [STARTING A FULL SYNC]`
        );
        return await this.startFullSync(state);
      }
      if (page.through < page.from) {
        return state;
      }
      const records = page.blocks.flatMap((block) => block.records);
      await this.applyEffects(feedEffects(records), report);
      report.feedBlocks += page.through - page.from + 1;
      state = await this.save({ ...state, next_height: page.next });
    }
    return state;
  }

  /**
   * A page of the feed, or null when the gateway no longer holds the height.
   * Asked three times first: another API node behind the gateway may hold it.
   */
  private async feedPage(from: number) {
    for (let attempt = 0; attempt < FEED_GONE_ATTEMPTS; attempt++) {
      try {
        return await this.gateway.getChanges(from, { limit: FEED_PAGE_BLOCKS });
      } catch (error) {
        if (!(error instanceof ChainGatewayError) || error.code !== 'gone') {
          throw error;
        }
      }
    }
    return null;
  }

  /** Runs one identity's work; a failure is logged and reported, not thrown. */
  private async isolated(
    principalId: string,
    report: MirrorRunReport,
    work: () => Promise<void>
  ) {
    try {
      await work();
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      logger.error(`[IDENTITY ${principalId} NOT MIRRORED] ${message}`);
      report.failed.push(`${principalId}: ${message}`);
    }
  }

  /** The principals a feed page touches, with the wallets' old and new ones. */
  private async principalsOf(effects: FeedEffects): Promise<Set<string>> {
    const principals = new Set(effects.principals);
    if (!effects.wallets.size) {
      return principals;
    }
    const wallets = Array.from(effects.wallets);
    const now = await this.gateway.getIdentitiesByWallets(wallets);
    Object.values(now).forEach((it) => {
      if (it) principals.add(it.principalId.toLowerCase());
    });
    (await this.db.principalsOfWallets(wallets)).forEach((it) =>
      principals.add(it)
    );
    return principals;
  }

  private async applyEffects(effects: FeedEffects, report: MirrorRunReport) {
    const principals = await this.principalsOf(effects);
    const touched = new Set<string>(effects.wallets);
    for (const principal of Array.from(principals)) {
      const identity = await this.identity(principal);
      if (!identity) continue;
      await this.isolated(principal, report, async () => {
        (await this.applyIdentity(identity, report)).forEach((it) =>
          touched.add(it)
        );
      });
    }
    for (const target of Array.from(effects.ratingTargets)) {
      const identity = await this.identity(target);
      if (!identity) continue;
      await this.isolated(target, report, () =>
        this.syncTargetRatings(identity, report)
      );
    }
    for (const holder of Array.from(effects.delegationHolders)) {
      if (HEX20.test(holder)) {
        touched.add(holder);
        continue;
      }
      const identity = await this.identity(holder);
      identity?.wallets.forEach((it) => touched.add(it.toLowerCase()));
    }
    for (const wallet of Array.from(touched)) {
      await this.isolated(wallet, report, () =>
        this.syncWalletDelegations(wallet, report)
      );
    }
  }

  // ---------------------------------------------------------------- one identity

  private async identity(principalId: string): Promise<ChainIdentity | null> {
    const key = principalId.toLowerCase();
    if (!this.identities.has(key)) {
      this.identities.set(key, await this.gateway.getIdentityByPrincipal(key));
    }
    return this.identities.get(key) ?? null;
  }

  private async docOf(
    identity: ChainIdentity,
    report: MirrorRunReport
  ): Promise<ProfileDocFields | null | undefined> {
    const cid = identity.profile?.docCid;
    if (!cid) return null;
    try {
      const bytes = await this.gateway.getProfileDoc(cid);
      if (!bytes) {
        report.docProblems.push(
          `${identity.principalId}: ${cid} not in the store`
        );
        return undefined;
      }
      return toProfileDocFields(decodeProfileDoc(bytes));
    } catch (error) {
      report.docProblems.push(
        `${identity.principalId}: ${(error as Error)?.message ?? error}`
      );
      return undefined;
    }
  }

  /**
   * The 6529.io profile id of a chain identity: its mapping, else the
   * imported profile (legacy id), else the existing profile of one of its
   * wallets that no other identity holds, else one derived from its id.
   */
  async profileIdOf(identity: ChainIdentity): Promise<string> {
    const principalId = identity.principalId.toLowerCase();
    const mapped = await this.db.profileIdOfPrincipal(principalId);
    if (mapped) return mapped;
    const { profileId: chosen, origin } = await this.chooseProfileId(identity);
    try {
      await this.db.executeNativeQueriesInTransaction((conn) =>
        this.db.insertMapping(principalId, chosen, origin, this.now(), conn)
      );
    } catch (error) {
      // Another run mapped it meanwhile: use that.
      const again = await this.db.profileIdOfPrincipal(principalId);
      if (again) return again;
      throw error;
    }
    return chosen;
  }

  /**
   * The imported profile (legacy id), else an existing profile of one of its
   * wallets that the chain did not import for another identity, else one
   * derived from the principal id.
   */
  private async chooseProfileId(
    identity: ChainIdentity
  ): Promise<{ profileId: string; origin: string }> {
    const principalId = identity.principalId.toLowerCase();
    const legacy = identity.legacyId?.toLowerCase() ?? null;
    if (
      legacy &&
      (await this.db.profileExists(legacy)) &&
      !(await this.db.principalOfProfile(legacy))
    ) {
      return { profileId: legacy, origin: 'LEGACY' };
    }
    const candidates = await this.db.unmappedProfilesOfWallets(
      identity.wallets.map((it) => it.toLowerCase())
    );
    const free: typeof candidates = [];
    for (const candidate of candidates) {
      const importedTo = await this.gateway.getIdentityByLegacyProfileId(
        candidate.profile_id
      );
      if (importedTo?.principalId.toLowerCase() === principalId) {
        return { profileId: candidate.profile_id, origin: 'LEGACY' };
      }
      if (!importedTo) free.push(candidate);
    }
    const best = pickWalletProfile(
      free,
      identity.anchor?.toLowerCase() ?? null
    );
    if (best) {
      return { profileId: best, origin: 'WALLET' };
    }
    return { profileId: principalProfileId(principalId), origin: 'NEW' };
  }

  /** Writes one identity's rows; returns the wallets whose identity changed. */
  async applyIdentity(
    identity: ChainIdentity,
    report: MirrorRunReport
  ): Promise<string[]> {
    const wallets = identity.wallets.map((it) => it.toLowerCase());
    if (isInactive(identity)) {
      report.skippedInactive.push(identity.principalId);
      const survivor = identity.mergedInto
        ? await this.identity(identity.mergedInto)
        : null;
      return survivor?.wallets.length && !survivor.mergedInto
        ? await this.applyIdentity(survivor, report)
        : [];
    }
    if (consolidationKeyOf(wallets).length > MAX_CONSOLIDATION_KEY_LENGTH) {
      logger.error(
        `[IDENTITY ${identity.principalId} HAS ${wallets.length} WALLETS: TOO MANY FOR A 6529.IO CONSOLIDATION KEY, NOT MIRRORED]`
      );
      report.skippedTooManyWallets.push(identity.principalId);
      return [];
    }
    const doc = await this.docOf(identity, report);
    const profileId = await this.profileIdOf(identity);
    const view: ChainIdentityView = {
      principalId: identity.principalId.toLowerCase(),
      profileId,
      handle: identity.handle,
      wallets,
      primary: (
        identity.primary ??
        identity.anchor ??
        wallets[0]
      ).toLowerCase(),
      doc,
      rep: toNumber(identity.rep?.total),
      cic: toNumber(identity.nic?.total),
      levelRaw: identity.level ? toNumber(identity.level.raw) : null
    };
    const touched = await this.db.executeNativeQueriesInTransaction(
      async (conn) => {
        const state = await this.db.readIdentityState(
          wallets,
          profileId,
          identity.handle,
          view.primary,
          conn
        );
        const plan = planIdentity(view, state);
        await this.db.applyIdentityPlan(
          plan,
          CHAIN_BLOCK_BASE + Number(identity.createdHeight ?? 0),
          this.now(),
          conn
        );
        return plan.touchedWallets;
      }
    );
    report.identities++;
    return touched;
  }

  private ratingRow(
    rating: ChainRating,
    raterProfileId: string
  ): RatingRowWrite | null {
    const value = Math.trunc(toNumber(rating.value));
    if (!value || Math.abs(value) > MAX_RATING) return null;
    const matter = rating.matter.toUpperCase();
    if (matter === 'NIC' || matter === 'CIC') {
      return {
        rater_profile_id: raterProfileId,
        matter: 'CIC',
        matter_category: 'CIC',
        rating: value
      };
    }
    if (matter !== 'REP' || !rating.category?.name) return null;
    return {
      rater_profile_id: raterProfileId,
      matter: 'REP',
      matter_category: rating.category.name,
      rating: value
    };
  }

  /** A target's REP and CIC rows become the chain's ratings of it. */
  async syncTargetRatings(identity: ChainIdentity, report: MirrorRunReport) {
    if (isInactive(identity)) return;
    const targetProfileId = await this.profileIdOf(identity);
    const ratings: ChainRating[] = [];
    if ((identity.rep?.raters ?? 0) + (identity.nic?.raters ?? 0) > 0) {
      let after: string | null = null;
      for (;;) {
        const page = await this.gateway.getRatings(
          { target: identity.principalId },
          { after, limit: 1000 }
        );
        ratings.push(...(page?.items ?? []));
        if (!page?.next) break;
        after = page.next;
      }
    }
    const rows: RatingRowWrite[] = [];
    for (const rating of ratings) {
      const rater = await this.identity(rating.rater);
      if (!rater) continue;
      const row = this.ratingRow(rating, await this.profileIdOf(rater));
      if (row) rows.push(row);
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceTargetRatings(targetProfileId, rows, this.now(), conn)
    );
    report.ratingTargets++;
  }

  /** A wallet's delegation rows become its own and its identity's records. */
  async syncWalletDelegations(wallet: string, report: MirrorRunReport) {
    const groups = (await this.gateway.getDelegationsOfWallet(wallet)) ?? [];
    const rows: DelegationRowWrite[] = [];
    for (const group of groups) {
      let records = group.records;
      if (group.more) {
        records = [];
        let after: string | null = null;
        for (;;) {
          const page = await this.gateway.getDelegations(
            { holder: group.holder },
            { after, limit: 1000 }
          );
          records.push(...(page?.items ?? []));
          if (!page?.next) break;
          after = page.next;
        }
      }
      for (const record of records) {
        const row = toDelegationRow(wallet, record);
        if (row) rows.push(row);
      }
    }
    await this.db.executeNativeQueriesInTransaction((conn) =>
      this.db.replaceWalletDelegations(wallet.toLowerCase(), rows, conn)
    );
    report.delegationWallets++;
  }
}

export const identityChainMirror = new IdentityChainMirror();
