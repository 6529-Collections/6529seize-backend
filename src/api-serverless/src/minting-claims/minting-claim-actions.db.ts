import { randomUUID } from 'node:crypto';
import { MINTING_CLAIM_ACTIONS_TABLE } from '@/constants';
import type { MintingClaimActionType } from '@/minting-claims/minting-claim-actions';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { Time } from '@/time';

export interface MintingClaimActionRow {
  id: string;
  contract: string;
  token_id: number;
  action: MintingClaimActionType;
  completed: boolean | number;
  created_by_wallet: string;
  updated_by_wallet: string;
  created_at: number;
  updated_at: number;
}

export class MintingClaimActionsDb extends LazyDbAccessCompatibleService {
  public async findByContractAndTokenId(
    contract: string,
    tokenId: number,
    ctx: RequestContext
  ): Promise<MintingClaimActionRow[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findByContractAndTokenId`);
      return await this.db.execute<MintingClaimActionRow>(
        `
        select
          id,
          contract,
          token_id,
          action,
          completed,
          created_by_wallet,
          updated_by_wallet,
          created_at,
          updated_at
        from ${MINTING_CLAIM_ACTIONS_TABLE}
        where contract = :contract
          and token_id = :tokenId
        order by updated_at desc, action asc
      `,
        {
          contract: contract.toLowerCase(),
          tokenId
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findByContractAndTokenId`);
    }
  }

  public async upsertAction(
    param: {
      contract: string;
      token_id: number;
      action: MintingClaimActionType;
      completed: boolean;
      wallet: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->upsertAction`);
      const now = Time.currentMillis();
      const normalizedContract = param.contract.toLowerCase();
      const normalizedWallet = param.wallet.toLowerCase();
      await this.db.execute(
        `
        insert into ${MINTING_CLAIM_ACTIONS_TABLE}
        (
          id,
          contract,
          token_id,
          action,
          completed,
          created_by_wallet,
          updated_by_wallet,
          created_at,
          updated_at
        )
        values
        (
          :id,
          :contract,
          :token_id,
          :action,
          :completed,
          :created_by_wallet,
          :updated_by_wallet,
          :created_at,
          :updated_at
        )
        on duplicate key update
          completed = :completed_update,
          updated_by_wallet = :updated_by_wallet_update,
          updated_at = :updated_at_update
      `,
        {
          id: randomUUID(),
          contract: normalizedContract,
          token_id: param.token_id,
          action: param.action,
          completed: param.completed,
          created_by_wallet: normalizedWallet,
          updated_by_wallet: normalizedWallet,
          created_at: now,
          updated_at: now,
          completed_update: param.completed,
          updated_by_wallet_update: normalizedWallet,
          updated_at_update: now
        },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->upsertAction`);
    }
  }
}

export const mintingClaimActionsDb = new MintingClaimActionsDb(dbSupplier);
