import { ProfileProxyActionType } from './entities/IProfileProxyAction';
import type {
  WalletAuthClientType,
  WalletAuthSignatureFormat
} from './entities/IWalletAuthSession';
import { enums } from './enums';

/**
 * The `ct` access-token claim: the session type that minted the token, or
 * `legacy` for `/auth/login` and legacy refresh-token redemption.
 */
export type AccessTokenClientType = WalletAuthClientType | 'legacy';

/**
 * The `sb` access-token claim: how the wallet approved the session. Adds
 * `legacy_text` (a plain-text `/auth/login` signature) to the stored formats.
 */
export type AccessTokenBinding = WalletAuthSignatureFormat | 'legacy_text';

/**
 * Session claims of the caller's access token. Tokens minted before these
 * claims existed carry none of them, so every field may be null.
 */
export interface AccessTokenSession {
  readonly clientType: AccessTokenClientType | null;
  readonly binding: AccessTokenBinding | null;
  readonly sessionId: string | null;
}

export class AuthenticationContext {
  readonly authenticatedWallet: string | null;
  readonly authenticatedProfileId: string | null;
  readonly roleProfileId: string | null;
  readonly activeProxyActions: Partial<
    Record<ProfileProxyActionType, AuthenticatedProxyAction>
  >;
  readonly accessTokenSession: AccessTokenSession | null;

  public static notAuthenticated(): AuthenticationContext {
    return new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: null,
      roleProfileId: null,
      activeProxyActions: []
    });
  }

  constructor({
    authenticatedWallet,
    authenticatedProfileId,
    roleProfileId,
    activeProxyActions,
    accessTokenSession = null
  }: {
    readonly authenticatedWallet: string | null;
    readonly authenticatedProfileId: string | null;
    readonly roleProfileId: string | null;
    readonly activeProxyActions: AuthenticatedProxyAction[];
    readonly accessTokenSession?: AccessTokenSession | null;
  }) {
    this.authenticatedWallet = authenticatedWallet;
    this.authenticatedProfileId = authenticatedProfileId;
    this.roleProfileId = roleProfileId;
    this.accessTokenSession = accessTokenSession;
    this.activeProxyActions = activeProxyActions.reduce(
      (acc, action) => {
        const type = enums.resolve(ProfileProxyActionType, action.type);
        if (type) {
          acc[type] = action;
        }
        return acc;
      },
      {} as Record<ProfileProxyActionType, AuthenticatedProxyAction>
    );
  }

  public isUserFullyAuthenticated(): boolean {
    return this.authenticatedProfileId !== null;
  }

  public isAuthenticatedAsProxy(): boolean {
    return (
      this.roleProfileId !== null &&
      this.roleProfileId !== undefined &&
      this.authenticatedProfileId !== this.roleProfileId
    );
  }

  public getActingAsId(): string | null {
    return this.isAuthenticatedAsProxy()
      ? this.roleProfileId!
      : (this.authenticatedProfileId ?? null);
  }

  public hasProxyAction(type: ProfileProxyActionType): boolean {
    return !!this.activeProxyActions[type];
  }

  public hasRightsTo(type: ProfileProxyActionType): boolean {
    return (
      this.isUserFullyAuthenticated() &&
      (!this.isAuthenticatedAsProxy() || !!this.activeProxyActions[type])
    );
  }

  static fromProfileId(contextProfileId: string) {
    return new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: contextProfileId,
      roleProfileId: null,
      activeProxyActions: []
    });
  }

  public getLoggedInUsersProfileId(): string | null {
    return this.isAuthenticatedAsProxy()
      ? this.authenticatedProfileId
      : (this.roleProfileId ?? this.authenticatedProfileId ?? null);
  }
}

export interface AuthenticatedProxyAction {
  readonly id: string;
  readonly type: ProfileProxyActionType;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}
