/**
 * What the profile site index reads from the 6529 chain gateway.
 *
 * The method names follow the shared gateway client (`ChainGatewayClient` in
 * `src/chain-gateway`), so the adapter that replaces the fixtures is a thin
 * mapping once that module lands.
 */
export interface ProfileCmsChainReadOptions {
  readonly height?: number;
}

/** One finalized write of `Profile[p]`: a PROFILE_REPLACE or the identity import. */
export interface ProfileCmsProfileChange {
  readonly height: number;
  readonly time_ms: number;
  readonly principal: string;
  readonly version: number;
  /** The new ProfileDoc's CID; null when the person erased their document. */
  readonly doc_cid: string | null;
  /**
   * Who wrote it, when the gateway says: the identity import or an operation
   * (PROFILE_REPLACE, IDENTITY_CREATE). Absent: the index decides from the
   * import's height range.
   */
  readonly source?: 'import' | 'operation';
}

/** The chain's `IdentityImport` record: the heights the import wrote in. */
export interface ProfileCmsIdentityImport {
  readonly start_height: number;
  /** Null while the import is still running. */
  readonly done_height: number | null;
}

export interface ProfileCmsProfileChangesPage {
  readonly changes: readonly ProfileCmsProfileChange[];
  /** The next height to ask from; null when the page reached the finalized head. */
  readonly next_height: number | null;
}

export interface ProfileCmsChainIdentity {
  readonly principal: string;
  /** 6529.io's profile id: the imported legacy UUID, or the mirror's id for a chain-only identity. */
  readonly profile_id: string;
  readonly handle: string | null;
  /** Bound wallets, lower case. */
  readonly wallets: readonly string[];
  /** True for an identity the import created from a 6529.io profile (it has a legacy id). */
  readonly imported: boolean;
}

export type ProfileCmsDocRead =
  | {
      readonly status: 'found';
      readonly fields: Readonly<Record<string, string>>;
    }
  /** Not in the document store (yet). */
  | { readonly status: 'missing' }
  /** In the store, but not a ProfileDoc.v1. */
  | { readonly status: 'malformed'; readonly reason: string };

export interface ProfileCmsChainPort {
  /** Profile changes at or after `fromHeight`, in height order. */
  getChanges(fromHeight: number): Promise<ProfileCmsProfileChangesPage>;

  /** The identity import's height range; null when no import ran. */
  getIdentityImport(): Promise<ProfileCmsIdentityImport | null>;

  getIdentityByPrincipal(
    principal: string,
    opts?: ProfileCmsChainReadOptions
  ): Promise<ProfileCmsChainIdentity | null>;

  /**
   * A ProfileDoc's fields (key to value), as the identity mirror's ProfileDoc
   * decoder (`decodeProfileDoc`) returns them.
   */
  getProfileDoc(cid: string): Promise<ProfileCmsDocRead>;

  /**
   * The CID of the ProfileDoc the identity import wrote for `principal`: its
   * entry in the import's document list (the import file's
   * `profile_doc_cid`); null when the import wrote none for it.
   */
  getImportedProfileDocCid(principal: string): Promise<string | null>;

  /** Raw bytes of a file in the gateway's document store; null when absent. */
  getDocBytes(cid: string): Promise<Buffer | null>;

  /** Stores a file in the gateway's document store; returns its CID. */
  putDocBytes(bytes: Buffer): Promise<string>;
}
