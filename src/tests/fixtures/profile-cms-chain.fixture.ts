import { TypedDataEncoder, Wallet } from 'ethers';
import { cmsCidFromBytes } from '@/profile-cms/chain/profile-cms-cid';
import {
  ProfileCmsChainIdentity,
  ProfileCmsChainPort,
  ProfileCmsDocRead,
  ProfileCmsIdentityImport,
  ProfileCmsProfileChange,
  ProfileCmsProfileChangesPage
} from '@/profile-cms/chain/profile-cms-chain.port';
import {
  ProfileDocCms,
  profileDocCmsFields
} from '@/profile-cms/chain/profile-doc-cms';
import { buildProfileCmsPublicationManifest } from '@/profile-cms/profile-cms-publication';
import { buildProfileCmsPublishTypedData } from '@/profile-cms/profile-cms-signing';
import {
  canonicalizeJson,
  CmsPackageV1,
  toPackageHashInput,
  withComputedCmsHashes
} from '@/profile-cms/protocol/v1';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';
import { ProfileCmsPackageEntity } from '@/entities/IProfileCmsPackage';
import { getCmsPackageHash, hashCmsJson } from '@/api/cms/cms.hashing';
import { LegacySignatureForm } from '@/profile-cms/chain/profile-cms-archive';
import { legacySignedMessages } from '@/profile-cms/chain/profile-cms-legacy-signature';

/** Test keys only: never a real wallet. */
export const CHAIN_FIXTURE_WALLET = new Wallet(`0x${'11'.repeat(32)}`);
export const CHAIN_FIXTURE_OTHER_WALLET = new Wallet(`0x${'22'.repeat(32)}`);
export const CHAIN_FIXTURE_PRINCIPAL = `0x${'0'.repeat(63)}1`;
export const CHAIN_FIXTURE_PROFILE_ID = 'test-profile-1';
/** A Safe's address in tests: a contract the test's EIP-1271 verifier answers for. */
export const CHAIN_FIXTURE_SAFE = `0x${'0'.repeat(39)}5`;
export const CHAIN_FIXTURE_HANDLE = 'testhandle';

export interface SignedSiteFixture {
  readonly cmsPackage: CmsPackageV1;
  readonly coreBytes: Buffer;
  readonly coreCid: string;
  readonly publicationBytes: Buffer;
  readonly publicationCid: string;
  readonly packageHash: string;
  readonly draftId: string;
  readonly typedDataHash: string;
}

/** A content core and its wallet-signed publication record, as 6529.io's publish writes them. */
export function aSignedProfileSite(
  options: {
    readonly title?: string;
    readonly draftId?: string;
    readonly version?: number;
    readonly profileId?: string;
    readonly handle?: string;
    readonly wallet?: Wallet;
    /** Signed by this Safe (EIP-1271) instead of the wallet. */
    readonly safe?: string;
    readonly publishedAt?: number;
  } = {}
): SignedSiteFixture {
  const profileId = options.profileId ?? CHAIN_FIXTURE_PROFILE_ID;
  const handle = options.handle ?? CHAIN_FIXTURE_HANDLE;
  const wallet = options.wallet ?? CHAIN_FIXTURE_WALLET;
  const signer = options.safe ?? wallet.address;
  const draftId = options.draftId ?? 'draft-1';
  const version = options.version ?? 1;
  const base = createValidProfileCmsPackage({ profileId, handle });
  let cmsPackage = withComputedCmsHashes({
    ...base,
    profile: { ...base.profile, primary_wallet: signer },
    site: { ...base.site, title: options.title ?? 'Test site' }
  });
  const coreBytes = Buffer.from(
    canonicalizeJson(toPackageHashInput(cmsPackage))
  );
  const packageHash = cmsPackage.integrity.package_hash;
  const receipt = {
    provider: 'arweave' as const,
    uri: `ar://${'a'.repeat(43)}`,
    content_hash: packageHash,
    canonical: true,
    recorded_at: '2026-11-20T00:00:00.000Z'
  };
  const message = {
    action: 'publish' as const,
    profileId,
    handle,
    packageId: cmsPackage.package_id,
    version,
    draftId,
    payloadHash: cmsPackage.integrity.payload_hash,
    packageHash,
    primaryPath: `/${handle}/index.html`,
    storageProvider: receipt.provider,
    storageUri: receipt.uri,
    storageContentHash: packageHash,
    deadline: 1_790_000_000_000
  };
  const request = {
    signer_address: signer,
    signature: '',
    chain_id: 1,
    deadline: message.deadline,
    ...(options.safe ? { is_safe_signature: true } : {})
  };
  const typedData = buildProfileCmsPublishTypedData({ request, message });
  const typedDataHash = TypedDataEncoder.hash(
    typedData.domain,
    typedData.types,
    message
  );
  // The digest signTypedData signs, signed synchronously so seeds can be built
  // at load time. A Safe's signature is whatever its contract accepts.
  const signature = options.safe
    ? `0x${'ab'.repeat(65)}`
    : wallet.signingKey.sign(typedDataHash).serialized;
  cmsPackage = {
    ...cmsPackage,
    signatures: [
      {
        type: 'eip712',
        signer,
        signature,
        signed_at: '2026-11-20T00:00:00.000Z',
        domain: { ...typedData.domain, typed_data_hash: typedDataHash }
      }
    ],
    storage: [receipt]
  };
  const manifest = buildProfileCmsPublicationManifest({
    entity: { profile_id: profileId } as ProfileCmsPackageEntity,
    cmsPackage,
    request: { ...request, signature },
    verification: {
      valid: true,
      signer_address: signer.toLowerCase(),
      typed_data: typedData,
      typed_data_hash: typedDataHash
    },
    publishedAt: options.publishedAt ?? 1_790_000_000_000
  });
  const publicationBytes = Buffer.from(canonicalizeJson(manifest));
  return {
    cmsPackage,
    coreBytes,
    coreCid: cmsCidFromBytes(coreBytes),
    publicationBytes,
    publicationCid: cmsCidFromBytes(publicationBytes),
    packageHash,
    draftId,
    typedDataHash
  };
}

/**
 * ProfileDoc.v1 bytes: schema, principal, version, prev, nonce, the fields
 * (keys strictly ascending bytewise) and sig, in canonical encoding
 * (big-endian uint32 lengths and counts), with an empty `prev` and `sig`.
 * Test documents only.
 */
export function encodeTestProfileDoc(params: {
  readonly principal: string;
  readonly version: number;
  readonly fields: Readonly<Record<string, string>>;
}): Buffer {
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([u32(bytes.length), bytes]);
  };
  const keys = Object.keys(params.fields).sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  );
  return Buffer.concat([
    text('6529.ProfileDoc.v1'),
    Buffer.from(params.principal.slice(2).padStart(64, '0'), 'hex'),
    u32(params.version),
    u32(0),
    Buffer.alloc(32, 0xab),
    u32(keys.length),
    ...keys.flatMap((key) => [text(key), text(params.fields[key])]),
    u32(0)
  ]);
}

/** A gateway and document store in memory, for the follower and the rebuild. */
export class InMemoryProfileCmsChain implements ProfileCmsChainPort {
  private readonly files = new Map<string, Buffer>();
  /** Each ProfileDoc's fields by CID, as the identity mirror's decoder reads them. */
  private readonly docFields = new Map<
    string,
    Readonly<Record<string, string>>
  >();
  private readonly importDocs = new Map<string, string>();
  private readonly identities = new Map<string, ProfileCmsChainIdentity>();
  private readonly changes: ProfileCmsProfileChange[] = [];
  private finalizedHeight = Number.MAX_SAFE_INTEGER;
  private identityImport: ProfileCmsIdentityImport | null = null;

  /** The heights the identity import wrote in. */
  setIdentityImport(identityImport: ProfileCmsIdentityImport | null): void {
    this.identityImport = identityImport;
  }

  async getIdentityImport(): Promise<ProfileCmsIdentityImport | null> {
    return this.identityImport;
  }

  /** Hides changes above this height, as a feed that has not finalized them yet. */
  setFinalizedHeight(height: number): void {
    this.finalizedHeight = height;
  }

  addFile(bytes: Buffer): string {
    const cid = cmsCidFromBytes(bytes);
    this.files.set(cid, bytes);
    return cid;
  }

  /** Takes a file out of the store, as one not uploaded yet. */
  removeFile(cid: string): Buffer | null {
    const bytes = this.files.get(cid) ?? null;
    this.files.delete(cid);
    return bytes;
  }

  addSite(site: SignedSiteFixture): void {
    this.addFile(site.coreBytes);
    this.addFile(site.publicationBytes);
  }

  setIdentity(identity: ProfileCmsChainIdentity): void {
    this.identities.set(identity.principal, identity);
  }

  /**
   * Writes a ProfileDoc version (its fields), as a PROFILE_REPLACE or the
   * import would. `importDoc` lists it in the import's document list.
   */
  replaceProfile(params: {
    readonly principal?: string;
    readonly version: number;
    readonly height: number;
    readonly timeMs: number;
    readonly doc: Readonly<Record<string, string>> | null;
    readonly source?: 'import' | 'operation';
    readonly importDoc?: boolean;
  }): string | null {
    const principal = params.principal ?? CHAIN_FIXTURE_PRINCIPAL;
    let docCid: string | null = null;
    if (params.doc) {
      docCid = this.addFile(
        encodeTestProfileDoc({
          principal,
          version: params.version,
          fields: params.doc
        })
      );
      this.docFields.set(docCid, params.doc);
    }
    if (params.importDoc && docCid) {
      this.importDocs.set(principal, docCid);
    }
    this.changes.push({
      height: params.height,
      time_ms: params.timeMs,
      principal,
      version: params.version,
      doc_cid: docCid,
      ...(params.source ? { source: params.source } : {})
    });
    return docCid;
  }

  async getChanges(fromHeight: number): Promise<ProfileCmsProfileChangesPage> {
    return {
      changes: this.changes
        .filter(
          (change) =>
            change.height >= fromHeight && change.height <= this.finalizedHeight
        )
        .sort((left, right) => left.height - right.height),
      next_height: null
    };
  }

  async getIdentityByPrincipal(
    principal: string
  ): Promise<ProfileCmsChainIdentity | null> {
    return this.identities.get(principal) ?? null;
  }

  async getProfileDoc(cid: string): Promise<ProfileCmsDocRead> {
    if (!this.files.has(cid)) {
      return { status: 'missing' };
    }
    const fields = this.docFields.get(cid);
    return fields
      ? { status: 'found', fields }
      : { status: 'malformed', reason: 'not a ProfileDoc.v1' };
  }

  async getImportedProfileDocCid(principal: string): Promise<string | null> {
    return this.importDocs.get(principal) ?? null;
  }

  async getDocBytes(cid: string): Promise<Buffer | null> {
    return this.files.get(cid) ?? null;
  }

  async putDocBytes(bytes: Buffer): Promise<string> {
    return this.addFile(bytes);
  }
}

export function aChainIdentity(
  overrides: Partial<ProfileCmsChainIdentity> = {}
): ProfileCmsChainIdentity {
  return {
    principal: CHAIN_FIXTURE_PRINCIPAL,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    handle: CHAIN_FIXTURE_HANDLE,
    wallets: [CHAIN_FIXTURE_WALLET.address.toLowerCase()],
    imported: true,
    ...overrides
  };
}

/** A ProfileDoc's fields: a display name, and the profile site keys of `cms`. */
export function aProfileDoc(
  cms: Partial<ProfileDocCms> | null = null
): Record<string, string> {
  return {
    displayName: CHAIN_FIXTURE_HANDLE,
    ...profileDocCmsFields({
      primary: cms?.primary ?? null,
      archive: cms?.archive ?? null
    })
  };
}

/**
 * A legacy CMS package in the shape the legacy API accepts: the signature
 * envelope and the storage list sit inside the package JSON, and
 * `package_hash` covers both. The signature signs `form`'s message.
 */
export function aLegacyPackage(options: {
  readonly title: string;
  readonly form?: LegacySignatureForm;
  readonly wallet?: Wallet;
  readonly signingWallet?: string;
  readonly badSignature?: boolean;
}): {
  readonly packageJson: Record<string, unknown>;
  readonly packageHash: string;
  readonly payloadHash: string;
  readonly signatureJson: Record<string, unknown>;
  readonly storage: unknown[];
} {
  const wallet = options.wallet ?? CHAIN_FIXTURE_WALLET;
  const payload = { title: options.title, blocks: [{ text: options.title }] };
  const payloadHash = hashCmsJson(payload);
  const storage = [{ provider: 'ipfs', uri: 'ipfs://test', pinned: true }];
  const unsigned: Record<string, unknown> = {
    schema: '6529.cms.payload.v1',
    payload,
    payload_hash: payloadHash,
    storage
  };
  const form = options.form ?? 'personal_sign_unsigned_hash';
  const message = legacySignedMessages({
    payloadHash,
    packageJson: unsigned
  }).find(([candidate]) => candidate === form);
  if (!message) throw new Error(`Unknown legacy form ${form}`);
  const signatureJson = {
    signature_type: 'eip191',
    signing_wallet: (options.signingWallet ?? wallet.address).toLowerCase(),
    signed_at: '2026-11-01T00:00:00.000Z',
    signature: options.badSignature
      ? `0x${'12'.repeat(65)}`
      : wallet.signMessageSync(message[1]())
  };
  const packageJson: Record<string, unknown> = {
    ...unsigned,
    signature: signatureJson,
    package_hash: ''
  };
  packageJson.package_hash = getCmsPackageHash(packageJson);
  return {
    packageJson,
    packageHash: packageJson.package_hash as string,
    payloadHash,
    signatureJson,
    storage
  };
}
