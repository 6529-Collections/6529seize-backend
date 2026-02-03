import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RefreshToken } from '../../../entities/IRefreshToken';
import { REFRESH_TOKENS_TABLE } from '@/constants';
import { randomBytes } from 'crypto';
import { equalIgnoreCase } from '../../../strings';

export class AuthDb extends LazyDbAccessCompatibleService {
  async retrieveOrGenerateRefreshToken(address: string): Promise<string> {
    const existingToken = await this.db.oneOrNull<RefreshToken>(
      `select refresh_token from ${REFRESH_TOKENS_TABLE} where address = :address`,
      { address }
    );
    if (existingToken) {
      return existingToken.refresh_token;
    }
    const refreshToken = randomBytes(64).toString('hex');
    await this.db.execute(
      `insert into ${REFRESH_TOKENS_TABLE} (address, refresh_token) values (:address, :refreshToken)`,
      { address, refreshToken }
    );
    return refreshToken;
  }

  async redeemRefreshToken(
    address: string,
    refreshToken: string
  ): Promise<boolean> {
    const result = await this.db.oneOrNull<RefreshToken>(
      `select address from ${REFRESH_TOKENS_TABLE} where refresh_token = :refreshToken`,
      { refreshToken }
    );
    return !!result?.address && equalIgnoreCase(address, result.address);
  }
}

export const authDb = new AuthDb(dbSupplier);
