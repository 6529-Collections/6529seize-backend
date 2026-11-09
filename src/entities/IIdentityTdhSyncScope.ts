import { Entity, PrimaryColumn } from 'typeorm';
import { IDENTITY_TDH_SYNC_SCOPE_TABLE } from '@/constants/db-tables';

/**
 * What each consolidated-TDH generation changed, so the identities metrics
 * sync (step C, identity-tdh-sync.ts) can recompute only those identities
 * instead of walking all of them. Rows are written inside the transaction
 * that makes the change and deleted once their generation is synced:
 *
 * - `SCOPE_RECORDED` (value ''): written by a partial TDH write (step A) with
 *   its keys. A pending generation without it (a full rewrite, or a write by
 *   older code) makes the next sync walk every identity.
 * - `CONSOLIDATION_KEY`: a key whose consolidated TDH rows step A replaced or
 *   wrote, or whose identity step B wrote.
 * - `PROFILE`: a profile whose identity step B wrote, or a merge source or
 *   target.
 */
@Entity(IDENTITY_TDH_SYNC_SCOPE_TABLE)
export class IdentityTdhSyncScopeEntity {
  @PrimaryColumn({ type: 'bigint' })
  readonly generation!: number;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly kind!: string;

  /** Same type as identities.consolidation_key. */
  @PrimaryColumn({ type: 'varchar', length: 200 })
  readonly value!: string;
}
