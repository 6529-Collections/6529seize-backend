import { PROFILE_CMS_AGENT_EVENTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(PROFILE_CMS_AGENT_EVENTS_TABLE)
@Index('idx_cms_agent_event_profile', ['profile_id', 'created_at'])
export class ProfileCmsAgentEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly grant_id!: string;
  @Column({ type: 'varchar', length: 36, nullable: true })
  readonly proposal_id!: string | null;
  @Column({ type: 'varchar', length: 20 })
  readonly event_type!:
    | 'issued'
    | 'revoked'
    | 'proposed'
    | 'rejected'
    | 'applied';
  @Column({ type: 'varchar', length: 42, nullable: true })
  readonly actor_wallet!: string | null;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
