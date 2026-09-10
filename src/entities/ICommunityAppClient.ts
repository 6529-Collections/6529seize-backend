import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { COMMUNITY_APP_CLIENTS_TABLE } from '@/constants';

@Entity(COMMUNITY_APP_CLIENTS_TABLE)
export class CommunityAppClientEntity {
  @PrimaryColumn({ type: 'varchar', length: 64, nullable: false })
  readonly client_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly name!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly description!: string;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: false })
  readonly created_by_address!: string;

  @Column({ type: 'text', nullable: false })
  readonly allowed_redirect_uris!: string; // JSON array of exact URIs

  @Column({ type: 'varchar', length: 255, nullable: false, default: 'identity:read' })
  readonly allowed_scopes!: string; // comma-separated scope strings

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly is_active!: boolean;

  @Column({
    type: 'datetime',
    precision: 3,
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP(3)'
  })
  readonly created_at!: Date;

  @Column({ type: 'datetime', precision: 3, nullable: true, default: null })
  readonly deactivated_at!: Date | null;
}