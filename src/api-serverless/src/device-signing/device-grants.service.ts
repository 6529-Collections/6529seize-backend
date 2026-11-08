import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { ApiRegisterDeviceGrantRequest } from '@/api/generated/models/ApiRegisterDeviceGrantRequest';
import { mainnetContractWalletVerifier } from '@/api/e2ee/e2ee-context';
import { AuthenticationContext } from '@/auth-context';
import { isE2eeEnabled } from '@/e2ee/e2ee-flag';
import { E2eeContractWalletVerifier } from '@/e2ee/e2ee-grant';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorisedException
} from '@/exceptions';
import { identitiesDb, IdentitiesDb } from '@/identities/identities.db';
import { RequestContext } from '@/request.context';
import {
  AppDeviceGrant,
  findAppDeviceGrantRegistrationProblem,
  hasMlsDeviceKey,
  serializeAppDeviceGrantMessage,
  verifyAppDeviceGrant
} from './app-device-grant';
import {
  computeDeviceGrantId,
  DeviceGrantScope,
  DeviceGrantTerms,
  DEVICE_GRANT_KEY_TYPE,
  sanitizeDeviceLabel,
  serializeDeviceGrantScopes
} from './device-grant-message';
import { DeviceSigningDb, deviceSigningDb } from './device-signing.db';
import {
  toApiDeviceGrant,
  toOwnedApiDeviceGrant
} from './device-signing.mappers';

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

/**
 * App grants are EIP-712 typed data, so EIP-1271 contract wallets are checked
 * on Ethereum mainnet; the stored chain id records that chain.
 */
const APP_GRANT_CHAIN_ID = 1;

export interface AppGrantDeps {
  readonly contractWalletVerifier: E2eeContractWalletVerifier;
  readonly e2eeEnabled: () => boolean;
}

const defaultAppGrantDeps: AppGrantDeps = {
  contractWalletVerifier: mainnetContractWalletVerifier,
  e2eeEnabled: () => isE2eeEnabled()
};

function toAppDeviceGrant(
  request: ApiRegisterDeviceGrantRequest
): AppDeviceGrant {
  const { grant } = request;
  return {
    wallet: grant.wallet.toLowerCase(),
    device_key: grant.device_key.toLowerCase(),
    scopes: grant.scopes as DeviceGrantScope[],
    mls_device_key: grant.mls_device_key?.toLowerCase() ?? null,
    ciphersuite: grant.ciphersuite ?? null,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
    origin: grant.origin
  };
}

export class DeviceGrantsService {
  constructor(
    private readonly db: DeviceSigningDb,
    private readonly identities: IdentitiesDb,
    private readonly now: () => number = () => Date.now(),
    private readonly appGrantDeps: AppGrantDeps = defaultAppGrantDeps
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
    return this.storeGrant(entity, ctx);
  }

  /**
   * Registers an app grant (EIP-712) that 6529 Mobile or 6529 Desktop had the
   * signed-in wallet sign outside a web sign-in. Only that wallet's own
   * session may register it; idempotent on grant id, so a revoked grant
   * stays revoked.
   */
  async registerAppGrant(
    request: ApiRegisterDeviceGrantRequest,
    ctx: GrantCallerContext
  ): Promise<ApiDeviceGrant> {
    const caller = this.resolveCaller(ctx.authenticationContext);
    const grant = toAppDeviceGrant(request);
    if (grant.wallet !== caller.wallet) {
      throw new ForbiddenException(
        'A device grant must be signed by the signed-in wallet'
      );
    }
    const nowMs = this.now();
    const problem = findAppDeviceGrantRegistrationProblem(
      grant,
      Math.floor(nowMs / 1000)
    );
    if (problem) {
      throw new BadRequestException(`Invalid device grant: ${problem}`);
    }
    if (hasMlsDeviceKey(grant)) {
      await this.assertCanGrantEncryptedMessages(caller, ctx);
    }
    const signature = request.wallet_signature.toLowerCase();
    const verification = await verifyAppDeviceGrant({
      grant,
      signature,
      contractWalletVerifier: this.appGrantDeps.contractWalletVerifier
    });
    if (!verification.ok) {
      throw new BadRequestException(
        `Invalid device grant: ${verification.reason}`
      );
    }
    return this.storeGrant(
      {
        id: verification.grantId,
        wallet: grant.wallet,
        key_type: DEVICE_GRANT_KEY_TYPE,
        device_key: grant.device_key,
        scopes: serializeDeviceGrantScopes(grant.scopes),
        device_label: sanitizeDeviceLabel(request.device_label),
        domain: grant.origin,
        message: serializeAppDeviceGrantMessage(verification.message),
        wallet_signature: signature,
        chain_id: APP_GRANT_CHAIN_ID,
        issued_at: grant.issued_at * 1000,
        expires_at: grant.expires_at * 1000,
        created_at: nowMs,
        revoked_at: null,
        last_used_at: null
      },
      ctx
    );
  }

  /**
   * As at sign-in, an encrypted-messages key is granted only while encrypted
   * messages are on and to a wallet with a profile: an MLS device can only
   * join a profile.
   */
  private async assertCanGrantEncryptedMessages(
    caller: { readonly wallet: string; readonly profileId: string | null },
    ctx: RequestContext
  ): Promise<void> {
    if (!this.appGrantDeps.e2eeEnabled()) {
      throw new BadRequestException(
        'Invalid device grant: encrypted messages are off'
      );
    }
    const profileId =
      caller.profileId ??
      (await this.identities.getProfileIdByWallet(caller.wallet, ctx.timer));
    if (!profileId) {
      throw new BadRequestException(
        'Invalid device grant: encrypted messages need a profile'
      );
    }
  }

  private async storeGrant(
    entity: DeviceGrantEntity,
    ctx: RequestContext
  ): Promise<ApiDeviceGrant> {
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
    return grants.map(toOwnedApiDeviceGrant);
  }

  async renameCallerGrant(
    grantId: string,
    label: string,
    ctx: GrantCallerContext
  ): Promise<ApiDeviceGrant> {
    const caller = this.resolveCaller(ctx.authenticationContext);
    const notFound = new NotFoundException(`Device grant ${grantId} not found`);
    if (!GRANT_ID_PATTERN.test(grantId)) {
      throw notFound;
    }
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx = { ...ctx, connection };
      const grant = await this.db.lockGrant(grantId, txCtx);
      if (
        grant?.revoked_at !== null ||
        !(await this.isCallerWallet(grant.wallet, caller, txCtx))
      ) {
        throw notFound;
      }
      await this.db.renameGrant(grantId, grant.wallet, label, txCtx);
      return toOwnedApiDeviceGrant({ ...grant, device_label: label });
    });
  }

  async acknowledgeCallerGrant(
    grantId: string,
    ctx: GrantCallerContext
  ): Promise<ApiDeviceGrant> {
    const caller = this.resolveCaller(ctx.authenticationContext);
    const notFound = new NotFoundException(`Device grant ${grantId} not found`);
    if (!GRANT_ID_PATTERN.test(grantId)) {
      throw notFound;
    }
    return this.db.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx = { ...ctx, connection };
      const grant = await this.db.lockGrant(grantId, txCtx);
      if (
        !grant ||
        grant.revoked_at !== null ||
        Number(grant.expires_at) <= this.now() ||
        !(await this.isCallerWallet(grant.wallet, caller, txCtx))
      ) {
        throw notFound;
      }
      if (!grant.notice_acknowledged) {
        await this.db.acknowledgeGrant(grantId, txCtx);
      }
      return toOwnedApiDeviceGrant({ ...grant, notice_acknowledged: true });
    });
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
      return toOwnedApiDeviceGrant(grant);
    }
    await this.db.revokeGrant(grantId, this.now(), ctx);
    const revoked = await this.db.findGrantById(grantId, ctx);
    if (!revoked) {
      throw notFound;
    }
    return toOwnedApiDeviceGrant(revoked);
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
    caller: { readonly wallet: string; readonly profileId: string | null },
    ctx?: RequestContext
  ): Promise<boolean> {
    if (!caller.profileId) {
      return grantWallet.toLowerCase() === caller.wallet;
    }
    if (ctx?.connection) {
      const identity = await this.identities.getIdentityByWallet(
        grantWallet.toLowerCase(),
        ctx.connection
      );
      return identity?.profile_id === caller.profileId;
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
