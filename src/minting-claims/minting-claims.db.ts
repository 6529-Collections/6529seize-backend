import { MEMES_SEASONS_TABLE, MINTING_CLAIMS_TABLE } from '@/constants';
import { numbers } from '@/numbers';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { MintingClaimRowInput } from './minting-claim-from-drop.builder';

const mysql = require('mysql');

export class MintingClaimsDb extends LazyDbAccessCompatibleService {
  async existsByDropId(
    contract: string,
    dropId: string,
    connection?: RequestContext['connection']
  ): Promise<boolean> {
    const rows = await this.db.execute<{ drop_id: string }>(
      `SELECT drop_id
       FROM ${MINTING_CLAIMS_TABLE}
       WHERE contract = :contract
         AND drop_id = :dropId
       LIMIT 1`,
      { contract: contract.toLowerCase(), dropId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.length > 0;
  }

  async getMaxSeasonId(ctx: RequestContext): Promise<number> {
    const result = await this.db.execute<{ max_id: unknown }>(
      `SELECT COALESCE(MAX(id), 0) as max_id FROM ${MEMES_SEASONS_TABLE}`,
      undefined,
      ctx?.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    const maxSeasonId = numbers.parseIntOrNull(result?.[0]?.max_id);
    if (maxSeasonId === null) {
      throw new Error(
        `Invalid max season id type/value from DB: ${result?.[0]?.max_id}`
      );
    }
    return maxSeasonId;
  }

  async getMaxClaimId(
    contract: string,
    ctx: RequestContext
  ): Promise<number | null> {
    const result = await this.db.execute<{ claim_id: unknown }>(
      `SELECT claim_id
       FROM ${MINTING_CLAIMS_TABLE}
       WHERE contract = :contract
       ORDER BY claim_id DESC
       LIMIT 1`,
      { contract: contract.toLowerCase() },
      ctx?.connection ? { wrappedConnection: ctx.connection } : undefined
    );

    if (!result.length) {
      return null;
    }

    const maxClaimId = numbers.parseIntOrNull(result[0].claim_id);
    if (maxClaimId === null) {
      throw new Error(
        `Invalid max claim id type/value from DB: ${result[0].claim_id}`
      );
    }
    return maxClaimId;
  }

  async createMintingClaim(
    rows: MintingClaimRowInput[],
    ctx: RequestContext
  ): Promise<void> {
    if (!rows.length) return;
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('Minting claims can only be saved in a transaction');
    }
    ctx?.timer?.start(`${this.constructor.name}->createMintingClaim`);
    try {
      const sql = `
      INSERT INTO ${MINTING_CLAIMS_TABLE} (drop_id, contract, claim_id, image_location, animation_location, metadata_location, edition_size, description, name, image_url, attributes, image_details, animation_url, animation_details)
      VALUES ${rows
        .map(
          (r) =>
            `(${mysql.escape(r.drop_id)}, ${mysql.escape(r.contract)}, ${mysql.escape(r.claim_id)}, ${mysql.escape(r.image_location)}, ${mysql.escape(r.animation_location)}, ${mysql.escape(r.metadata_location)}, NULL, ${mysql.escape(r.description)}, ${mysql.escape(r.name)}, ${mysql.escape(r.image_url)}, ${mysql.escape(JSON.stringify(r.attributes))}, ${r.image_details ? mysql.escape(JSON.stringify(r.image_details)) : mysql.escape(null)}, ${mysql.escape(r.animation_url)}, ${r.animation_details ? mysql.escape(JSON.stringify(r.animation_details)) : mysql.escape(null)})`
        )
        .join(', ')}
    `;
      await this.db.execute(sql, undefined, {
        wrappedConnection: connection
      });
    } finally {
      ctx?.timer?.stop(`${this.constructor.name}->createMintingClaim`);
    }
  }
}

export const mintingClaimsDb = new MintingClaimsDb(dbSupplier);
