import { MEMES_CLAIMS_TABLE, MEMES_SEASONS_TABLE } from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import type { MemeClaimRowInput } from './meme-claim-from-drop.builder';

const mysql = require('mysql');

export class MemeClaimsDb extends LazyDbAccessCompatibleService {
  async getMaxSeasonId(ctx: RequestContext): Promise<number> {
    const result = await this.db.execute<{ max_id: number }>(
      `SELECT COALESCE(MAX(id), 0) as max_id FROM ${MEMES_SEASONS_TABLE}`,
      undefined,
      ctx?.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    return result?.[0]?.max_id ?? 0;
  }

  async createMemeClaim(
    rows: MemeClaimRowInput[],
    ctx: RequestContext
  ): Promise<void> {
    if (!rows.length) return;
    const connection = ctx.connection;
    if (!connection) {
      throw new Error('Meme claims can only be saved in a transaction');
    }
    ctx?.timer?.start(`${this.constructor.name}->createMemeClaim`);
    try {
      const sql = `
      INSERT INTO ${MEMES_CLAIMS_TABLE} (drop_id, meme_id, season, image_location, animation_location, metadata_location, arweave_synced_at, edition_size, description, name, image_url, attributes, image_details, animation_url, animation_details)
      VALUES ${rows
        .map(
          (r) =>
            `(${mysql.escape(r.drop_id)}, ${mysql.escape(r.meme_id)}, ${mysql.escape(r.season)}, ${mysql.escape(r.image_location)}, ${mysql.escape(r.animation_location)}, ${mysql.escape(r.metadata_location)}, NULL, NULL, ${mysql.escape(r.description)}, ${mysql.escape(r.name)}, ${mysql.escape(r.image_url)}, ${mysql.escape(JSON.stringify(r.attributes))}, ${r.image_details ? mysql.escape(JSON.stringify(r.image_details)) : mysql.escape(null)}, ${mysql.escape(r.animation_url)}, ${r.animation_details ? mysql.escape(JSON.stringify(r.animation_details)) : mysql.escape(null)})`
        )
        .join(', ')}
    `;
      await this.db.execute(sql, undefined, {
        wrappedConnection: connection
      });
    } finally {
      ctx?.timer?.stop(`${this.constructor.name}->createMemeClaim`);
    }
  }
}

export const memeClaimsDb = new MemeClaimsDb(dbSupplier);
