import { Column, Entity, PrimaryColumn } from 'typeorm';
import { WAVE_CHAT_DROP_COOLDOWNS_TABLE } from '@/constants';

@Entity(WAVE_CHAT_DROP_COOLDOWNS_TABLE)
export class WaveChatDropCooldownEntity {
  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
  readonly profile_id!: string;

  @Column({ type: 'bigint', nullable: false, default: 0 })
  readonly next_drop_timestamp!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}
