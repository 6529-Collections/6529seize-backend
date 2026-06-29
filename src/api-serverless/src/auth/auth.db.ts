import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { DbPoolName, DbQueryOptions } from '@/db-query.options';
import { RefreshToken } from '../../../entities/IRefreshToken';
import {
  REFRESH_TOKENS_TABLE,
  WALLET_AUTH_SESSIONS_TABLE,
  WALLET_CONNECTION_SHARES_TABLE
} from '@/constants';
import { randomBytes } from 'node:crypto';
import { equalIgnoreCase } from '../../../strings';
import {
  WalletAuthClientType,
  WalletAuthSessionEntity
} from '../../../entities/IWalletAuthSession';
import { WalletConnectionShareEntity } from '../../../entities/IWalletConnectionShare';

type RefreshTokenWalletAuthClientType = Exclude<WalletAuthClientType, 'web'>;

const CLIENT_TYPE_WEB: WalletAuthClientType = 'web';
const CLIENT_TYPE_NATIVE: RefreshTokenWalletAuthClientType = 'native';

type AuthDbConnection = ConnectionWrapper<any>;

function getDbOptions(connection?: AuthDbConnection): DbQueryOptions {
  return connection
    ? { wrappedConnection: connection }
    : { forcePool: DbPoolName.WRITE };
}

type CreateWalletAuthSessionParams = {
  readonly id: string;
  readonly address: string;
  readonly role: string | null;
  readonly clientType: WalletAuthClientType;
  readonly secretHash: string | null;
  readonly refreshTokenHash: string | null;
  readonly userAgentHash: string | null;
  readonly signatureDomain: string | null;
  readonly clientOrigin: string | null;
  readonly expiresAt: Date;
};

type CreateWalletConnectionShareParams = {
  readonly id: string;
  readonly connectionShareCodeHash: string;
  readonly address: string;
  readonly role: string | null;
  readonly targetClientType: WalletAuthClientType;
  readonly expiresAt: Date;
};

export type RedeemedLegacyRefreshToken = {
  readonly address: string;
  readonly role: string | null;
};

export class AuthDb extends LazyDbAccessCompatibleService {
  async retrieveOrGenerateRefreshToken(
    address: string,
    role: string | null
  ): Promise<string> {
    const existingToken = await this.db.oneOrNull<RefreshToken>(
      `select refresh_token, role from ${REFRESH_TOKENS_TABLE} where address = :address`,
      { address }
    );
    if (existingToken) {
      if (existingToken.role !== role) {
        await this.updateRefreshTokenRole(
          address,
          existingToken.refresh_token,
          role
        );
      }
      return existingToken.refresh_token;
    }
    const refreshToken = randomBytes(64).toString('hex');
    await this.db.execute(
      `insert into ${REFRESH_TOKENS_TABLE} (address, refresh_token, role) values (:address, :refreshToken, :role)`,
      { address, refreshToken, role }
    );
    return refreshToken;
  }

  async redeemRefreshToken(
    address: string | null | undefined,
    refreshToken: string
  ): Promise<RedeemedLegacyRefreshToken | null> {
    const result = await this.db.oneOrNull<RefreshToken>(
      `select address, role from ${REFRESH_TOKENS_TABLE} where refresh_token = :refreshToken`,
      { refreshToken }
    );
    if (!result?.address) {
      return null;
    }
    if (address && !equalIgnoreCase(address, result.address)) {
      return null;
    }
    return {
      address: result.address.toLowerCase(),
      role: result.role ?? null
    };
  }

  async bindUnboundRefreshTokenRole(
    address: string,
    refreshToken: string,
    role: string
  ): Promise<boolean> {
    const result = await this.db.execute(
      `update ${REFRESH_TOKENS_TABLE}
       set role = :role
       where address = :address
         and refresh_token = :refreshToken
         and role is null`,
      { address, refreshToken, role }
    );
    return this.db.getAffectedRows(result) === 1;
  }

  private async updateRefreshTokenRole(
    address: string,
    refreshToken: string,
    role: string | null
  ): Promise<void> {
    await this.db.execute(
      `update ${REFRESH_TOKENS_TABLE}
       set role = :role
       where address = :address and refresh_token = :refreshToken`,
      { address, refreshToken, role }
    );
  }

  async createWalletAuthSession(
    params: CreateWalletAuthSessionParams,
    connection?: AuthDbConnection
  ): Promise<WalletAuthSessionEntity> {
    await this.db.execute(
      `insert into ${WALLET_AUTH_SESSIONS_TABLE}
       (id, address, role, client_type, secret_hash, refresh_token_hash, user_agent_hash, signature_domain, client_origin, expires_at)
       values (:id, :address, :role, :clientType, :secretHash, :refreshTokenHash, :userAgentHash, :signatureDomain, :clientOrigin, :expiresAt)`,
      params,
      getDbOptions(connection)
    );
    return this.getWalletAuthSessionByIdOrThrow(params.id, connection);
  }

  async getActiveWebSessionBySecretHash(
    id: string,
    secretHash: string,
    now: Date
  ): Promise<WalletAuthSessionEntity | null> {
    return this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE}
       where id = :id
         and client_type = :clientType
         and secret_hash = :secretHash
         and revoked_at is null
         and expires_at > :now`,
      { id, secretHash, now, clientType: CLIENT_TYPE_WEB }
    );
  }

  async getActiveNativeSessionByRefreshHash(
    address: string,
    refreshTokenHash: string,
    now: Date,
    clientType: RefreshTokenWalletAuthClientType = CLIENT_TYPE_NATIVE
  ): Promise<WalletAuthSessionEntity | null> {
    return this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE}
       where address = :address
         and client_type = :clientType
         and refresh_token_hash = :refreshTokenHash
         and revoked_at is null
         and expires_at > :now`,
      { address, refreshTokenHash, now, clientType }
    );
  }

  async rotateWebSessionSecret(params: {
    readonly sessionId: string;
    readonly previousSecretHash: string;
    readonly nextSecretHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<WalletAuthSessionEntity | null> {
    const result = await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set secret_hash = :nextSecretHash,
           expires_at = :expiresAt,
           last_used_at = :now
       where id = :sessionId
         and client_type = :clientType
         and secret_hash = :previousSecretHash
         and revoked_at is null
         and expires_at > :now`,
      { ...params, clientType: CLIENT_TYPE_WEB }
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.getWalletAuthSessionByIdOrThrow(params.sessionId);
  }

  async rotateNativeSessionRefreshToken(params: {
    readonly sessionId: string;
    readonly previousRefreshTokenHash: string;
    readonly nextRefreshTokenHash: string;
    readonly expiresAt: Date;
    readonly now: Date;
    readonly clientType?: RefreshTokenWalletAuthClientType;
  }): Promise<WalletAuthSessionEntity | null> {
    const clientType = params.clientType ?? CLIENT_TYPE_NATIVE;
    const result = await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set refresh_token_hash = :nextRefreshTokenHash,
           expires_at = :expiresAt,
           last_used_at = :now
       where id = :sessionId
         and client_type = :clientType
         and refresh_token_hash = :previousRefreshTokenHash
         and revoked_at is null
         and expires_at > :now`,
      { ...params, clientType }
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.getWalletAuthSessionByIdOrThrow(params.sessionId);
  }

  async revokeWalletAuthSession(sessionId: string, now: Date): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where id = :sessionId`,
      { sessionId, now }
    );
  }

  async revokeWalletAuthSessionByRefreshHash(
    refreshTokenHash: string,
    now: Date
  ): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where refresh_token_hash = :refreshTokenHash`,
      { refreshTokenHash, now }
    );
  }

  async revokeWalletAuthSessionsForAddress(
    address: string,
    now: Date
  ): Promise<void> {
    await this.db.execute(
      `update ${WALLET_AUTH_SESSIONS_TABLE}
       set revoked_at = coalesce(revoked_at, :now)
       where address = :address and revoked_at is null`,
      { address, now }
    );
  }

  async createWalletConnectionShare(
    params: CreateWalletConnectionShareParams
  ): Promise<WalletConnectionShareEntity> {
    await this.db.execute(
      `insert into ${WALLET_CONNECTION_SHARES_TABLE}
       (id, connection_share_code_hash, address, role, target_client_type, expires_at)
       values (:id, :connectionShareCodeHash, :address, :role, :targetClientType, :expiresAt)`,
      params
    );
    return this.getWalletConnectionShareByIdOrThrow(params.id);
  }

  async consumeWalletConnectionShare(
    params: {
      readonly connectionShareCodeHash: string;
      readonly targetClientType: WalletAuthClientType;
      readonly now: Date;
    },
    connection?: AuthDbConnection
  ): Promise<WalletConnectionShareEntity | null> {
    const result = await this.db.execute(
      `update ${WALLET_CONNECTION_SHARES_TABLE}
       set consumed_at = :now
       where connection_share_code_hash = :connectionShareCodeHash
         and target_client_type = :targetClientType
         and consumed_at is null
         and expires_at > :now`,
      params,
      getDbOptions(connection)
    );
    if (this.db.getAffectedRows(result) !== 1) {
      return null;
    }
    return this.db.oneOrNull<WalletConnectionShareEntity>(
      `select * from ${WALLET_CONNECTION_SHARES_TABLE}
       where connection_share_code_hash = :connectionShareCodeHash`,
      { connectionShareCodeHash: params.connectionShareCodeHash },
      getDbOptions(connection)
    );
  }

  async markWalletConnectionShareSession(
    shareId: string,
    sessionId: string,
    connection?: AuthDbConnection
  ): Promise<void> {
    const result = await this.db.execute(
      `update ${WALLET_CONNECTION_SHARES_TABLE}
       set consumed_session_id = :sessionId
       where id = :shareId`,
      { shareId, sessionId },
      getDbOptions(connection)
    );
    if (this.db.getAffectedRows(result) !== 1) {
      throw new Error(
        `Wallet connection share ${shareId} not found while marking consumed session`
      );
    }
  }

  private async getWalletAuthSessionByIdOrThrow(
    id: string,
    connection?: AuthDbConnection
  ): Promise<WalletAuthSessionEntity> {
    const session = await this.db.oneOrNull<WalletAuthSessionEntity>(
      `select * from ${WALLET_AUTH_SESSIONS_TABLE} where id = :id`,
      { id },
      getDbOptions(connection)
    );
    if (!session) {
      throw new Error(`Wallet auth session ${id} not found after write`);
    }
    return session;
  }

  private async getWalletConnectionShareByIdOrThrow(
    id: string,
    connection?: AuthDbConnection
  ): Promise<WalletConnectionShareEntity> {
    const share = await this.db.oneOrNull<WalletConnectionShareEntity>(
      `select * from ${WALLET_CONNECTION_SHARES_TABLE} where id = :id`,
      { id },
      getDbOptions(connection)
    );
    if (!share) {
      throw new Error(`Wallet connection share ${id} not found after write`);
    }
    return share;
  }
}

export const authDb = new AuthDb(dbSupplier);
