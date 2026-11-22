import {
  ChainGatewayClient,
  ChainGatewayError,
  cidPath
} from '@/chain-gateway/chain-gateway.client';
import {
  ChainFeedBlock,
  ChainFeedRecord,
  ChainIdentity
} from '@/chain-gateway/chain-gateway.types';
import { RequestContext } from '@/request.context';
import {
  ChainReadRetryLater,
  messageOf,
  readWholeBlocks
} from './chain-feed-pages';

export { ChainReadRetryLater };
import { WalletPrincipalUnknownError } from './identity-chain-lookups';
import { numberOrNull } from './identity-chain-mirror.db';
import { decodeProfileDoc } from './profile-doc';

/**
 * What the profile site index reads from the 6529 chain, served from the
 * shared gateway client and the identity mirror's profile ids. The shapes
 * are the index's chain port, written out here so this module stands on its
 * own; TypeScript matches them by shape.
 */

/** Profile[principalId] = (version, docCid, updatedHeight). */
export const PROFILE_FAMILY = '0x0104';
const FEED_PAGE_BLOCKS = 200;
/** A page of changes ends at the block where it reaches this many. */
const MAX_PAGE_CHANGES = 100;

export interface ProfileSiteChange {
  readonly height: number;
  readonly time_ms: number;
  readonly principal: string;
  readonly version: number;
  /** The ProfileDoc's CID as base32 text; null when the document was erased. */
  readonly doc_cid: string | null;
  /** Written by the identity import or by an operation; absent when unknown. */
  readonly source?: 'import' | 'operation';
}

export interface ProfileSiteChangesPage {
  readonly changes: readonly ProfileSiteChange[];
  /** The next height to ask from; null once the finalized head is reached. */
  readonly next_height: number | null;
}

export interface ProfileSiteIdentity {
  readonly principal: string;
  /** The 6529.io profile id the identity mirror gives it. */
  readonly profile_id: string;
  readonly handle: string | null;
  readonly wallets: readonly string[];
  /** Created by the import from a 6529.io profile. */
  readonly imported: boolean;
}

export type ProfileSiteDocRead =
  | {
      readonly status: 'found';
      readonly fields: Readonly<Record<string, string>>;
    }
  | { readonly status: 'missing' }
  | { readonly status: 'malformed'; readonly reason: string };

export interface ProfileSiteChainPort {
  getChanges(fromHeight: number): Promise<ProfileSiteChangesPage>;
  getIdentityImport(): Promise<{
    readonly start_height: number;
    readonly done_height: number | null;
  } | null>;
  getIdentityByPrincipal(
    principal: string,
    opts?: { readonly height?: number }
  ): Promise<ProfileSiteIdentity | null>;
  getProfileDoc(cid: string): Promise<ProfileSiteDocRead>;
  getImportedProfileDocCid(principal: string): Promise<string | null>;
  getDocBytes(cid: string): Promise<Buffer | null>;
  putDocBytes(bytes: Buffer): Promise<string>;
}

/**
 * Runs at the end of a mirror run: the profile site index's
 * `followProfileCmsChanges(port, ctx)` goes in `PROFILE_SITE_FOLLOWERS`
 * (identity-chain-mirror.service.ts).
 */
export type ProfileSiteFollower = (
  port: ProfileSiteChainPort,
  ctx: RequestContext
) => Promise<unknown>;

type Gateway = Pick<
  ChainGatewayClient,
  | 'getChanges'
  | 'getMembership'
  | 'getIdentityByPrincipal'
  | 'getImportedIdentity'
  | 'getDocument'
  | 'putDocument'
>;

/**
 * The feed's import marker: true for the import, false for an operation;
 * null (a block that completed the import and also ran transactions) is
 * settled by comparing the document with the one the import wrote; absent
 * (an older gateway) leaves it to the index.
 */
function markedSource(record: ChainFeedRecord): ProfileSiteChange['source'] {
  if (record.byImport === true) return 'import';
  if (record.byImport === false) return 'operation';
  return undefined;
}

/**
 * A write of Profile[p] as a change. A deleted record (an identity merged
 * away) or a write without a version is not a change of the person's
 * document and is left out.
 */
function toChange(
  block: ChainFeedBlock,
  record: ChainFeedRecord
): ProfileSiteChange | null {
  const principal = record.keyFields?.principalId;
  const version = Number(record.valueFields?.version);
  if (
    typeof principal !== 'string' ||
    record.value === null ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    return null;
  }
  const cid = record.valueFields?.docCid;
  const source = markedSource(record);
  return {
    height: Number(block.height),
    time_ms: Number(block.time),
    principal: principal.toLowerCase(),
    version,
    doc_cid: typeof cid === 'string' && cid.length > 2 ? cidPath(cid) : null,
    ...(source ? { source } : {})
  };
}

/**
 * A wallet whose identity at a height is unknown, or whose history the
 * gateway answered in a way that can't be read, is tried again later.
 */
function retryOnUnknown(error: unknown): unknown {
  if (error instanceof WalletPrincipalUnknownError) {
    return new ChainReadRetryLater(error.message, 'wallet_unknown');
  }
  if (error instanceof ChainGatewayError && error.code === 'bad_answer') {
    return new ChainReadRetryLater(error.message, 'bad_answer');
  }
  return error;
}

/** Bytes that don't match their CID are the store's fault: try again later. */
function retryOnMismatch(error: unknown): unknown {
  return error instanceof ChainGatewayError && error.code === 'cid_mismatch'
    ? new ChainReadRetryLater(error.message, 'cid_mismatch')
    : error;
}

/** The profile site index's chain reads, from the gateway and the mirror. */
export class GatewayProfileSitePort implements ProfileSiteChainPort {
  constructor(
    private readonly gateway: Gateway,
    /**
     * The mirror's profile id for an identity (it maps one if needed), and
     * whether the import made the identity.
     */
    private readonly profileIdOf: (
      identity: ChainIdentity
    ) => Promise<{ profileId: string; imported: boolean }>,
    /** A wallet's principal at a height (throws when unknown). */
    private readonly walletPrincipalAt: (
      wallet: string,
      height: number
    ) => Promise<string | null>,
    /** Past `deadline`, a read of changes ends the follower's pass. */
    private readonly options: {
      readonly deadline?: number;
      readonly now?: () => number;
    } = {}
  ) {}

  /**
   * Profile writes from `fromHeight`. A height the gateway's feed no longer
   * holds (before its first, or in a gap) throws its `gone` refusal: the
   * index starts from a height the feed holds, such as the import's start.
   */
  async getChanges(fromHeight: number): Promise<ProfileSiteChangesPage> {
    const now = this.options.now ?? Date.now;
    if (this.options.deadline !== undefined && now() > this.options.deadline) {
      return { changes: [], next_height: null };
    }
    // No Profile is written before the import starts (identities come from
    // it), so a start below it reads from it instead of a height the feed
    // may not hold.
    const importStart = (await this.getIdentityImport())?.start_height ?? 0;
    // The index counts in whole heights: only whole blocks are given.
    const from = Math.max(fromHeight, importStart);
    const read = await readWholeBlocks(this.gateway, from, {
      limit: FEED_PAGE_BLOCKS,
      families: [PROFILE_FAMILY]
    });
    if (!read) {
      throw new ChainGatewayError(
        `/v1/feed: the gateway no longer holds height ${from}`,
        410,
        'gone',
        '/v1/feed'
      );
    }
    if (read.atHead) return { changes: [], next_height: null };
    const changes: ProfileSiteChange[] = [];
    for (const block of read.blocks) {
      await this.collect(block, changes);
      // A page full of changes ends at a block: the follower's pass then
      // checks its deadline between pages.
      if (changes.length >= MAX_PAGE_CHANGES) {
        return { changes, next_height: Number(block.height) + 1 };
      }
    }
    return { changes, next_height: read.nextHeight };
  }

  /** A block's Profile writes as changes, the source settled when unmarked. */
  private async collect(block: ChainFeedBlock, changes: ProfileSiteChange[]) {
    for (const record of block.records) {
      const change =
        record.family.toLowerCase() === PROFILE_FAMILY &&
        toChange(block, record);
      if (!change) continue;
      changes.push(
        record.byImport === null ? await this.settleSource(change) : change
      );
    }
  }

  /**
   * A change in the block that completed the import, which also ran
   * transactions: the import's when its document is the one the import
   * wrote for that principal, else an operation's.
   */
  private async settleSource(
    change: ProfileSiteChange
  ): Promise<ProfileSiteChange> {
    const imported =
      change.version === 1
        ? await this.getImportedProfileDocCid(change.principal)
        : null;
    const source =
      imported !== null && imported === change.doc_cid ? 'import' : 'operation';
    return { ...change, source };
  }

  /**
   * The import's heights; null when no import ran. When this gateway's feed
   * starts after the import's first block, the start reads as 0: no
   * identity operation runs while the import runs, so every Profile write
   * up to its done height is the import's (the completing block is told
   * apart by each record's marker).
   */
  async getIdentityImport() {
    if (this.importHeights !== undefined) return this.importHeights;
    const membership = await this.gateway.getMembership();
    const state = membership?.import as
      | {
          startHeight?: number | null;
          doneHeight?: number | null;
          count?: number;
        }
      | undefined;
    if (!state || !state.count) {
      return null;
    }
    const heights = {
      start_height: Number(state.startHeight ?? 0),
      done_height: numberOrNull(state.doneHeight)
    };
    // Kept once the import is done: its heights don't change after that.
    if (heights.done_height !== null) this.importHeights = heights;
    return heights;
  }

  private importHeights:
    | { readonly start_height: number; readonly done_height: number | null }
    | undefined = undefined;

  /**
   * An identity now, or at a height: its wallets and handle then, its
   * profile id as the mirror files it now. The gateway keeps only recent
   * heights; for an older one the wallets are those of its wallets now that
   * were bound to it at that height (a wallet that has left since is not
   * listed), and the handle is the one it has now.
   */
  async getIdentityByPrincipal(
    principal: string,
    opts?: { readonly height?: number }
  ): Promise<ProfileSiteIdentity | null> {
    const current = await this.gateway.getIdentityByPrincipal(principal);
    if (opts?.height === undefined) {
      return current ? await this.toIdentity(current, current) : null;
    }
    try {
      const then = await this.gateway.getIdentityByPrincipal(principal, {
        height: opts.height
      });
      return then ? await this.toIdentity(current ?? then, then) : null;
    } catch (error) {
      if (
        !(error instanceof ChainGatewayError && error.code === 'height_gone')
      ) {
        throw error;
      }
    }
    if (!current) return null;
    return await this.toIdentity(current, {
      handle: current.handle,
      wallets: await this.walletsAt(current, opts.height)
    });
  }

  private async toIdentity(
    current: ChainIdentity,
    then: Pick<ChainIdentity, 'handle' | 'wallets'>
  ): Promise<ProfileSiteIdentity> {
    const { profileId, imported } = await this.profileIdOf(current);
    return {
      principal: current.principalId.toLowerCase(),
      profile_id: profileId,
      handle: then.handle,
      wallets: then.wallets.map((it) => it.toLowerCase()),
      imported
    };
  }

  /**
   * Of the identity's wallets now, those bound to it at `height`. A wallet
   * whose principal then is unknown throws ChainReadRetryLater, so the
   * follower tries the change again later rather than decide on a list that
   * may be short. A wallet that has left since is not listed; the gateway
   * has no route for an identity's wallets at an old height.
   */
  private async walletsAt(
    identity: ChainIdentity,
    height: number
  ): Promise<string[]> {
    const principal = identity.principalId.toLowerCase();
    const wallets: string[] = [];
    for (const wallet of identity.wallets) {
      let then: string | null;
      try {
        then = await this.walletPrincipalAt(wallet, height);
      } catch (error) {
        throw retryOnUnknown(error);
      }
      if (then === principal) wallets.push(wallet.toLowerCase());
    }
    return wallets;
  }

  async getProfileDoc(cid: string): Promise<ProfileSiteDocRead> {
    let bytes: Buffer | null;
    try {
      bytes = await this.gateway.getDocument(cid);
    } catch (error) {
      // A CID that can't name a checkable document is the document's fault;
      // bytes that don't match it are the store's, tried again later.
      if (error instanceof ChainGatewayError && error.code === 'bad_request') {
        return { status: 'malformed', reason: error.message };
      }
      throw retryOnMismatch(error);
    }
    if (!bytes) return { status: 'missing' };
    try {
      return { status: 'found', fields: decodeProfileDoc(bytes) };
    } catch (error) {
      return {
        status: 'malformed',
        reason: messageOf(error)
      };
    }
  }

  async getImportedProfileDocCid(principal: string): Promise<string | null> {
    const entry = await this.gateway.getImportedIdentity(principal);
    return entry?.profileDocCid ? cidPath(entry.profileDocCid) : null;
  }

  async getDocBytes(cid: string): Promise<Buffer | null> {
    try {
      return await this.gateway.getDocument(cid);
    } catch (error) {
      throw retryOnMismatch(error);
    }
  }

  async putDocBytes(bytes: Buffer): Promise<string> {
    return await this.gateway.putDocument(bytes);
  }
}
