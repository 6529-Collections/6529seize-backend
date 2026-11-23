import {
  ChainGatewayClient,
  chainGatewayClient
} from '@/chain-gateway/chain-gateway.client';
import { ChainIdentity } from '@/chain-gateway/chain-gateway.types';
import { appFeatures } from '@/app-features';
import { IdentityEntity } from '@/entities/IIdentity';
import { ProfileClassification } from '@/entities/IProfile';
import { enums } from '@/enums';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';
import {
  identityChainMirrorDb,
  IdentityChainMirrorDb
} from './identity-chain-mirror.db';
import {
  consolidationKeyOf,
  isPlaceholderHandle,
  placeholderHandle
} from './identity-plan';
import { ProfileIds } from './profile-ids';
import {
  decodeProfileDoc,
  ProfileDocFields,
  toProfileDocFields
} from './profile-doc';

const logger = Logger.get('CHAIN_IDENTITY_READS');

type Gateway = Pick<
  ChainGatewayClient,
  | 'getIdentityByWallet'
  | 'getIdentityByHandle'
  | 'getIdentityByPrincipal'
  | 'getIdentityByLegacyProfileId'
  | 'getProfileDoc'
  | 'getHandle'
  | 'getMembership'
  | 'getMembershipWallet'
  | 'getMembershipWalletHistory'
  | 'getImportedIdentity'
>;

/** The identity mirror's choice of profile ids, read only. */
type Ids = Pick<ProfileIds, 'chosenProfileId' | 'setImportHeights'>;

type MappingDb = Pick<
  IdentityChainMirrorDb,
  'profileIdOfPrincipal' | 'principalOfProfile'
>;

type RowsDb = Pick<
  IdentitiesDb,
  'getIdentityByWallet' | 'getIdentityByProfileId' | 'getIdentityByHandle'
>;

/** Step two: identity lookups read the 6529 chain (FEATURE_IDENTITY_READS_FROM_CHAIN). */
export function identityReadsFromChain(): boolean {
  return appFeatures.isIdentityReadsFromChainEnabled();
}

function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Identity lookups by wallet, handle and 6529.io profile id, read from the
 * 6529 chain through the gateway and shaped as 6529.io's identity rows, so
 * the identity fetcher and login keep their answers' shape. The chain gives
 * the wallets, handle, primary wallet, profile document, REP, NIC and level;
 * TDH and xTDH (the TDH loops') and the profile id mapping come from
 * 6529.io's index tables, which the identity mirror rebuilds from the chain.
 * A profile or wallet the chain does not hold (a profile that was never
 * imported) is answered from those tables as before.
 */
export class ChainIdentityReads {
  /** The import's heights were read (they don't change once it completed). */
  private importKnown = false;

  constructor(
    private readonly gateway: Gateway = chainGatewayClient,
    private readonly mapping: MappingDb = identityChainMirrorDb,
    private readonly rows: RowsDb = identitiesDb,
    private readonly ids: Ids = new ProfileIds(
      gateway,
      identityChainMirrorDb,
      () => Date.now()
    )
  ) {}

  /**
   * The 6529.io profile id the identity's rows use: its mapping, else the
   * id the identity mirror will store for it, chosen as the mirror chooses
   * (ProfileIds, read only: legacy id, the founding wallet's placeholder
   * when it is that wallet's first identity, else the derived id). Null
   * while the mirror can't choose yet (a founder wait, a history it can't
   * read yet): the identity is then answered as none, never with an id the
   * mirror won't store.
   */
  async profileIdOf(identity: ChainIdentity): Promise<string | null> {
    const principalId = identity.principalId.toLowerCase();
    const mapped = await this.mapping.profileIdOfPrincipal(principalId);
    if (mapped) return mapped;
    await this.readImportHeights();
    const chosen = await this.ids.chosenProfileId(identity);
    if (chosen === null) {
      logger.info(
        `[IDENTITY ${principalId} NOT PLACED YET] [ANSWERED AS NONE UNTIL THE MIRROR CHOOSES ITS PROFILE ID]`
      );
    }
    return chosen;
  }

  /** The import's heights for the choice, once the import has completed. */
  private async readImportHeights() {
    if (this.importKnown) return;
    const membership = await this.gateway.getMembership();
    const state = membership?.import as
      | {
          completed?: boolean;
          startHeight?: number | null;
          doneHeight?: number | null;
        }
      | undefined;
    if (!state?.completed) return;
    const height = (value: number | null | undefined) =>
      value === null ||
      value === undefined ||
      !Number.isSafeInteger(Number(value))
        ? null
        : Number(value);
    this.ids.setImportHeights(
      height(state.startHeight),
      height(state.doneHeight)
    );
    this.importKnown = true;
  }

  private async docOf(
    identity: ChainIdentity
  ): Promise<ProfileDocFields | null> {
    const cid = identity.profile?.docCid;
    if (!cid) return null;
    try {
      const bytes = await this.gateway.getProfileDoc(cid);
      return bytes ? toProfileDocFields(decodeProfileDoc(bytes)) : null;
    } catch (error) {
      logger.warn(
        `[PROFILE DOC ${cid} OF ${identity.principalId} UNREADABLE] ${(error as Error)?.message ?? error}`
      );
      return null;
    }
  }

  /**
   * A chain identity as a 6529.io identity row; null while its profile id
   * can't be chosen yet (answered as no identity).
   */
  async toIdentityEntity(
    identity: ChainIdentity
  ): Promise<IdentityEntity | null> {
    const wallets = identity.wallets.map((it) => it.toLowerCase());
    const primary = (
      identity.primary ??
      identity.anchor ??
      wallets[0]
    ).toLowerCase();
    const [profileId, doc] = await Promise.all([
      this.profileIdOf(identity),
      this.docOf(identity)
    ]);
    if (profileId === null) return null;
    const indexRow = await this.rows.getIdentityByProfileId(profileId);
    let handle: string;
    if (identity.handle) {
      const display = doc?.displayName;
      handle =
        display?.toLowerCase() === identity.handle.toLowerCase()
          ? display
          : identity.handle;
    } else if (indexRow?.handle && isPlaceholderHandle(indexRow.handle)) {
      handle = indexRow.handle;
    } else {
      handle = placeholderHandle(primary);
    }
    const rep = toNumber(identity.rep?.total);
    const tdh = toNumber(indexRow?.tdh);
    const xtdh = toNumber(indexRow?.xtdh);
    return {
      consolidation_key: consolidationKeyOf(wallets),
      profile_id: profileId,
      primary_address: primary,
      handle,
      normalised_handle: handle.toLowerCase(),
      tdh,
      rep,
      cic: toNumber(identity.nic?.total),
      // The chain's level is REP plus TDH; xTDH is not part of it.
      level_raw: identity.level ? toNumber(identity.level.raw) : rep + tdh,
      pfp: doc?.pfp ?? null,
      banner1: doc?.banner1 ?? null,
      banner2: doc?.banner2 ?? null,
      classification: doc?.classification
        ? (enums.resolve(ProfileClassification, doc.classification) ?? null)
        : null,
      sub_classification: doc?.subClassification ?? null,
      xtdh,
      xtdh_rate: toNumber(indexRow?.xtdh_rate),
      basetdh_rate: toNumber(indexRow?.basetdh_rate),
      produced_xtdh: toNumber(indexRow?.produced_xtdh),
      granted_xtdh: toNumber(indexRow?.granted_xtdh)
    };
  }

  private isLive(identity: ChainIdentity | null): identity is ChainIdentity {
    return (
      !!identity &&
      !identity.mergedInto &&
      identity.wallets.length > 0 &&
      (!identity.status || identity.status.toLowerCase() === 'active')
    );
  }

  async byWallet(wallet: string): Promise<IdentityEntity | null> {
    const identity = await this.gateway.getIdentityByWallet(wallet);
    if (this.isLive(identity)) return await this.toIdentityEntity(identity);
    return await this.unmapped(await this.rows.getIdentityByWallet(wallet));
  }

  async byHandle(handle: string): Promise<IdentityEntity | null> {
    const identity = await this.gateway.getIdentityByHandle(handle);
    if (this.isLive(identity)) return await this.toIdentityEntity(identity);
    if (!isPlaceholderHandle(handle)) return null;
    // A placeholder (`id-0x...`) is 6529.io's name for an identity without a
    // chain handle: find whose it is in the index, then read that identity.
    const row = await this.rows.getIdentityByHandle(handle, {});
    const principal = row?.profile_id
      ? await this.mapping.principalOfProfile(row.profile_id)
      : null;
    if (!principal) return row;
    const owner = await this.gateway.getIdentityByPrincipal(principal);
    return this.isLive(owner) ? await this.toIdentityEntity(owner) : null;
  }

  async byProfileId(profileId: string): Promise<IdentityEntity | null> {
    const id = profileId.toLowerCase();
    const principal = await this.mapping.principalOfProfile(id);
    const identity = principal
      ? await this.gateway.getIdentityByPrincipal(principal)
      : await this.gateway.getIdentityByLegacyProfileId(id);
    if (this.isLive(identity)) return await this.toIdentityEntity(identity);
    return principal
      ? null
      : await this.unmapped(await this.rows.getIdentityByProfileId(id));
  }

  /** A row the chain holds no identity for (never imported), else nothing. */
  private async unmapped(
    row: IdentityEntity | null
  ): Promise<IdentityEntity | null> {
    if (!row) return null;
    if (
      row.profile_id &&
      (await this.mapping.principalOfProfile(row.profile_id))
    ) {
      return null;
    }
    return row;
  }

  /** The chain's answer on a handle: free to claim now, or why not. */
  async handleAvailability(
    handle: string
  ): Promise<{ available: boolean; message: string }> {
    const answer = await this.gateway.getHandle(handle);
    if (!answer || !answer.valid) {
      return {
        available: false,
        message: `Invalid username. Use 3-15 letters, numbers, or underscores.`
      };
    }
    return answer.available
      ? { available: true, message: 'Username is available.' }
      : {
          available: false,
          message: `This username is not available. Please choose a different one.`
        };
  }
}

export const chainIdentityReads = new ChainIdentityReads();
