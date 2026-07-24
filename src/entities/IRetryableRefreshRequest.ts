import { Column } from 'typeorm';

/**
 * Shared persistence fields for coalescing refresh requests.
 *
 * MySQL hydrates BIGINT columns as strings so timestamps remain lossless.
 */
export abstract class RetryableRefreshRequestEntity {
  @Column({ type: 'bigint', nullable: false })
  readonly dirty_at!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true, default: null })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: string;
}
