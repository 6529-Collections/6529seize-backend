import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TELEMETRY_DIAGNOSTICS_TABLE } from '@/constants';

/**
 * User-sent diagnostics bundles (C52, "Send diagnostics"). Stored only
 * AES-256-GCM encrypted, deleted 14 days after upload, readable only by the
 * team. No IP address, user agent or account is recorded with a bundle.
 */
@Entity(TELEMETRY_DIAGNOSTICS_TABLE)
export class TelemetryDiagnosticsEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  readonly code!: string;

  @Column({ type: 'datetime', precision: 3 })
  readonly created_at!: Date;

  @Index()
  @Column({ type: 'datetime', precision: 3 })
  readonly expires_at!: Date;

  @Column({ type: 'varchar', length: 32 })
  readonly key_id!: string;

  @Column({ type: 'varbinary', length: 12 })
  readonly iv!: Buffer;

  @Column({ type: 'varbinary', length: 16 })
  readonly auth_tag!: Buffer;

  /** Encrypted gzip of the bundle JSON. */
  @Column({ type: 'mediumblob' })
  readonly ciphertext!: Buffer;

  @Column({ type: 'int' })
  readonly compressed_bytes!: number;

  @Column({ type: 'int' })
  readonly uncompressed_bytes!: number;
}
