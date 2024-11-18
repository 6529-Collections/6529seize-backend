import { ProfileProxyActionType } from './entities/IProfileProxyAction';
import { resolveEnum } from './helpers';

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
    this.activeProxyActions = activeProxyActions.reduce((acc, action) => {
      const type = resolveEnum(ProfileProxyActionType, action.type);
      if (type) {
        acc[type] = action;
      }
      return acc;
    }, {} as Record<ProfileProxyActionType, AuthenticatedProxyAction>);
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
      : this.authenticatedProfileId ?? null;
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
      : this.roleProfileId ?? this.authenticatedProfileId ?? null;
  }
}

export interface AuthenticatedProxyAction {
  readonly id: string;
  readonly type: ProfileProxyActionType;
  readonly credit_amount: number | null;
  readonly credit_spent: number | null;
}
