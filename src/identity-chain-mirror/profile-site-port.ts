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
import { WalletPrincipalUnknownError } from './identity-chain-lookups';
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

/** The profile site index's chain reads, from the gateway and the mirror. */
export class GatewayProfileSitePort implements ProfileSiteChainPort {
  constructor(
    private readonly gateway: Gateway,
    /** The mirror's profile id for an identity (it maps one if needed). */
    private readonly profileIdOf: (identity: ChainIdentity) => Promise<string>,
    /** A wallet's principal at a height (throws when unknown). */
    private readonly walletPrincipalAt: (
      wallet: string,
      height: number
    ) => Promise<string | null>
  ) {}

  async getChanges(fromHeight: number): Promise<ProfileSiteChangesPage> {
    const page = await this.gateway.getChanges(fromHeight, {
      limit: FEED_PAGE_BLOCKS,
      families: [PROFILE_FAMILY]
    });
    if (page.through < page.from) {
      return { changes: [], next_height: null };
    }
    const changes: ProfileSiteChange[] = [];
    for (const block of page.blocks) {
      for (const record of block.records) {
        const change = record.name === 'Profile' && toChange(block, record);
        if (!change) continue;
        changes.push(
          record.byImport === null ? await this.settleSource(change) : change
        );
      }
    }
    return { changes, next_height: page.next };
  }

  /**
   * A change in the block that completed the import, which also ran
   * transactions: the import's when its document is the one the import
   * wrote for that principal, else an operation's.
   */
  private async settleSource(
    change: ProfileSiteChange
  ): Promise<ProfileSiteChange> {
    const imported = await this.getImportedProfileDocCid(change.principal);
    const source =
      imported !== null && imported === change.doc_cid ? 'import' : 'operation';
    return { ...change, source };
  }

  /**
   * The import's heights; null when no import ran, or when this gateway
   * doesn't hold the import's first block (its feed starts later).
   */
  async getIdentityImport() {
    const membership = await this.gateway.getMembership();
    const state = membership?.import as
      | { startHeight?: number | null; doneHeight?: number | null }
      | undefined;
    if (state?.startHeight === null || state?.startHeight === undefined) {
      return null;
    }
    return {
      start_height: Number(state.startHeight),
      done_height:
        state.doneHeight === null || state.doneHeight === undefined
          ? null
          : Number(state.doneHeight)
    };
  }

  /**
   * An identity now, or at a height: its wallets and handle then, its
   * profile id as the mirror files it now. The gateway keeps only recent
   * heights; for an older one the wallets are those of its wallets now that
   * were bound to it at that height (a wallet that has left since is not
   * listed: a signer check then refuses rather than accepts).
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
    return {
      principal: current.principalId.toLowerCase(),
      profile_id: await this.profileIdOf(current),
      handle: then.handle,
      wallets: then.wallets.map((it) => it.toLowerCase()),
      imported: !!current.legacyId
    };
  }

  /** Of the identity's wallets now, those bound to it at `height`. */
  private async walletsAt(
    identity: ChainIdentity,
    height: number
  ): Promise<string[]> {
    const principal = identity.principalId.toLowerCase();
    const wallets: string[] = [];
    for (const wallet of identity.wallets) {
      try {
        if ((await this.walletPrincipalAt(wallet, height)) === principal) {
          wallets.push(wallet.toLowerCase());
        }
      } catch (error) {
        // Unknown at that height: not listed.
        if (!(error instanceof WalletPrincipalUnknownError)) throw error;
      }
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
      throw error;
    }
    if (!bytes) return { status: 'missing' };
    try {
      return { status: 'found', fields: decodeProfileDoc(bytes) };
    } catch (error) {
      return {
        status: 'malformed',
        reason: (error as Error)?.message ?? String(error)
      };
    }
  }

  async getImportedProfileDocCid(principal: string): Promise<string | null> {
    const entry = await this.gateway.getImportedIdentity(principal);
    return entry?.profileDocCid ? cidPath(entry.profileDocCid) : null;
  }

  async getDocBytes(cid: string): Promise<Buffer | null> {
    return await this.gateway.getDocument(cid);
  }

  async putDocBytes(bytes: Buffer): Promise<string> {
    return await this.gateway.putDocument(bytes);
  }
}
