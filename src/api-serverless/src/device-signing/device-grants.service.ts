import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { AuthenticationContext } from '@/auth-context';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorisedException
} from '@/exceptions';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { RequestContext } from '@/request.context';
import {
  computeDeviceGrantId,
  DeviceGrantTerms,
  sanitizeDeviceLabel,
  serializeDeviceGrantScopes
} from './device-grant-message';
import { DeviceSigningDb, deviceSigningDb } from './device-signing.db';
import { toApiDeviceGrant } from './device-signing.mappers';

const GRANT_ID_PATTERN = /^0x[0-9a-f]{64}$/;

export interface VerifiedLoginGrant {
  readonly terms: DeviceGrantTerms;
  // Exact SIWE message the wallet signed, and its verified signature.
  readonly message: string;
  readonly walletSignature: string;
  readonly wallet: string;
  readonly domain: string;
  readonly chainId: number;
  readonly issuedAt: Date;
  readonly deviceLabel: string | null | undefined;
}

type GrantCallerContext = RequestContext & {
  readonly authenticationContext: AuthenticationContext;
};

export class DeviceGrantsService {
  constructor(
    private readonly db: DeviceSigningDb,
    private readonly identities: IdentitiesDb,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Stores a grant carried by a SIWE login. Call only after the login
   * signature verified and its nonce was consumed. Idempotent on grant id.
   */
  async storeLoginGrant(
    grant: VerifiedLoginGrant,
    ctx: RequestContext
  ): Promise<ApiDeviceGrant> {
    const entity: DeviceGrantEntity = {
      id: computeDeviceGrantId(grant.message),
      wallet: grant.wallet.toLowerCase(),
      key_type: grant.terms.keyType,
      device_key: grant.terms.deviceKey,
      scopes: serializeDeviceGrantScopes(grant.terms.scopes),
      device_label: sanitizeDeviceLabel(grant.deviceLabel),
      domain: grant.domain,
      message: grant.message,
      wallet_signature: grant.walletSignature,
      chain_id: grant.chainId,
      issued_at: grant.issuedAt.getTime(),
      expires_at: grant.terms.expiresAtSeconds * 1000,
      created_at: this.now(),
      revoked_at: null,
      last_used_at: null
    };
    if (await this.db.insertGrant(entity, ctx)) {
      return toApiDeviceGrant(entity);
    }
    const existing = await this.db.findGrantById(entity.id, ctx);
    if (!existing) {
      throw new Error(`Device grant ${entity.id} could not be stored`);
    }
    return toApiDeviceGrant(existing);
  }

  async listCallerGrants(ctx: GrantCallerContext): Promise<ApiDeviceGrant[]> {
    const caller = this.resolveCaller(ctx.authenticationContext);
    const grants = caller.profileId
      ? await this.db.findGrantsOfProfile(caller.profileId, ctx)
      : await this.db.findGrantsOfWallet(caller.wallet, ctx);
    return grants.map(toApiDeviceGrant);
  }

  async revokeCallerGrant(
    grantId: string,
    ctx: GrantCallerContext
  ): Promise<ApiDeviceGrant> {
    const caller = this.resolveCaller(ctx.authenticationContext);
    const notFound = new NotFoundException(`Device grant ${grantId} not found`);
    if (!GRANT_ID_PATTERN.test(grantId)) {
      throw notFound;
    }
    const grant = await this.db.findGrantById(grantId, ctx);
    if (!grant || !(await this.isCallerWallet(grant.wallet, caller))) {
      throw notFound;
    }
    if (grant.revoked_at !== null) {
      return toApiDeviceGrant(grant);
    }
    await this.db.revokeGrant(grantId, this.now(), ctx);
    const revoked = await this.db.findGrantById(grantId, ctx);
    if (!revoked) {
      throw notFound;
    }
    return toApiDeviceGrant(revoked);
  }

  private resolveCaller(authenticationContext: AuthenticationContext): {
    readonly wallet: string;
    readonly profileId: string | null;
  } {
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(
        'Device grants are not available to proxies'
      );
    }
    const wallet = authenticationContext.authenticatedWallet;
    if (!wallet) {
      throw new UnauthorisedException('Authentication required');
    }
    return {
      wallet: wallet.toLowerCase(),
      profileId: authenticationContext.authenticatedProfileId
    };
  }

  private async isCallerWallet(
    grantWallet: string,
    caller: { readonly wallet: string; readonly profileId: string | null }
  ): Promise<boolean> {
    if (!caller.profileId) {
      return grantWallet.toLowerCase() === caller.wallet;
    }
    const grantProfileId = await this.identities.getProfileIdByWallet(
      grantWallet.toLowerCase()
    );
    return grantProfileId === caller.profileId;
  }
}

export const deviceGrantsService = new DeviceGrantsService(
  deviceSigningDb,
  identitiesDb
);
