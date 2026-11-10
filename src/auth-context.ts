import { ProfileProxyActionType } from './entities/IProfileProxyAction';
import { enums } from './enums';
import {
  isWaveAllowedByAllowlist,
  ProxyWaveAllowlist
} from './profile-proxies/proxy-wave-allowlist';

export class AuthenticationContext {
  readonly authenticatedWallet: string | null;
  readonly authenticatedProfileId: string | null;
  readonly roleProfileId: string | null;
  readonly activeProxyActions: Partial<
    Record<ProfileProxyActionType, AuthenticatedProxyAction>
  >;

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
    activeProxyActions
  }: {
    readonly authenticatedWallet: string | null;
    readonly authenticatedProfileId: string | null;
    readonly roleProfileId: string | null;
    readonly activeProxyActions: AuthenticatedProxyAction[];
  }) {
    this.authenticatedWallet = authenticatedWallet;
    this.authenticatedProfileId = authenticatedProfileId;
    this.roleProfileId = roleProfileId;
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

  /**
   * Whether this context may create or edit drops in `waveId` as the acting
   * profile. A fully authenticated non-proxy user always may (wave visibility,
   * group gates and content checks are enforced separately and still apply).
   * A proxy needs an active CREATE_DROP_TO_WAVE grant whose wave allowlist is
   * either unrestricted (null) or names `waveId`.
   */
  public hasRightsToPostInWave(waveId: string): boolean {
    if (!this.isUserFullyAuthenticated()) {
      return false;
    }
    if (!this.isAuthenticatedAsProxy()) {
      return true;
    }
    const action =
      this.activeProxyActions[ProfileProxyActionType.CREATE_DROP_TO_WAVE];
    if (!action) {
      return false;
    }
    return isWaveAllowedByAllowlist(action.wave_allowlist, waveId);
  }

  /**
   * True only for a proxy session whose grant does not cover `waveId`. Used by
   * read paths to report `authenticated_user_eligible*` as false for waves the
   * proxy cannot post in, without changing non-proxy behaviour.
   */
  public isProxyBarredFromPostingInWave(waveId: string): boolean {
    return this.isAuthenticatedAsProxy() && !this.hasRightsToPostInWave(waveId);
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
  /**
   * Wave scope of a CREATE_DROP_TO_WAVE grant: `null` is unrestricted (legacy
   * and the default for every other action type); a list restricts posting to
   * exactly those waves.
   */
  readonly wave_allowlist: ProxyWaveAllowlist;
}
