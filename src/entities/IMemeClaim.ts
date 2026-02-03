import { MEMES_CLAIMS_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity(MEMES_CLAIMS_TABLE)
export class MemeClaimEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;

  @Column({ type: 'int', unique: true })
  readonly meme_id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly image_location!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  readonly animation_location!: string | null;
}
