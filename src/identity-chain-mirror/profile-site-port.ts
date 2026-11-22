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
import { decodeProfileDoc } from './profile-doc';

/**
 * What the profile site index (src/profile-cms/chain) reads from the 6529
 * chain, served from the shared gateway client and the identity mirror's
 * profile ids. The shapes are the index's `ProfileCmsChainPort`, written out
 * here so this module stands on its own; TypeScript matches them by shape.
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
 * Runs after the mirror follows a page of the change feed: the profile site
 * index's `followProfileCmsChanges(port, ctx)` goes in
 * `PROFILE_SITE_FOLLOWERS` (identity-chain-mirror.service.ts).
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
 * null (a block that completed the import and ran transactions) or absent
 * leaves it to the index, which asks getImportedProfileDocCid.
 */
function sourceOf(record: ChainFeedRecord): ProfileSiteChange['source'] {
  if (record.byImport === true) return 'import';
  if (record.byImport === false) return 'operation';
  return undefined;
}

function toChange(
  block: ChainFeedBlock,
  record: ChainFeedRecord
): ProfileSiteChange | null {
  const principal = record.keyFields?.principalId;
  if (typeof principal !== 'string') return null;
  const cid = record.value === null ? null : record.valueFields?.docCid;
  const source = sourceOf(record);
  return {
    height: Number(block.height),
    time_ms: Number(block.time),
    principal: principal.toLowerCase(),
    version: Number(record.valueFields?.version ?? 0),
    doc_cid: typeof cid === 'string' && cid.length > 2 ? cidPath(cid) : null,
    ...(source ? { source } : {})
  };
}

/** The profile site index's chain reads, from the gateway and the mirror. */
export class GatewayProfileSitePort implements ProfileSiteChainPort {
  constructor(
    private readonly gateway: Gateway,
    /** The mirror's profile id for an identity (it maps one if needed). */
    private readonly profileIdOf: (identity: ChainIdentity) => Promise<string>
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
        if (change) changes.push(change);
      }
    }
    return { changes, next_height: page.next };
  }

  async getIdentityImport() {
    const membership = await this.gateway.getMembership();
    const state = membership?.import as
      | { startHeight?: number | null; doneHeight?: number | null }
      | undefined;
    if (!state) return null;
    return {
      start_height: Number(state.startHeight ?? 0),
      done_height:
        state.doneHeight === null || state.doneHeight === undefined
          ? null
          : Number(state.doneHeight)
    };
  }

  async getIdentityByPrincipal(
    principal: string,
    opts?: { readonly height?: number }
  ): Promise<ProfileSiteIdentity | null> {
    const identity = await this.gateway.getIdentityByPrincipal(
      principal,
      opts?.height === undefined ? undefined : { height: opts.height }
    );
    if (!identity) return null;
    return {
      principal: identity.principalId.toLowerCase(),
      profile_id: await this.profileIdOf(identity),
      handle: identity.handle,
      wallets: identity.wallets.map((it) => it.toLowerCase()),
      imported: !!identity.legacyId
    };
  }

  async getProfileDoc(cid: string): Promise<ProfileSiteDocRead> {
    let bytes: Buffer | null;
    try {
      bytes = await this.gateway.getDocument(cid);
    } catch (error) {
      if (
        error instanceof ChainGatewayError &&
        (error.code === 'cid_mismatch' || error.code === 'bad_request')
      ) {
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
