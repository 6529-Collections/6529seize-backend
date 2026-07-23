import { MEME_CARD_DROP_MAPPINGS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(MEME_CARD_DROP_MAPPINGS_TABLE)
@Index('meme_card_drop_mappings_drop_id_unique', ['drop_id'], {
  unique: true
})
export class MemeCardDropMappingEntity {
  @PrimaryColumn({ type: 'int', unsigned: true })
  readonly meme_card_id!: number;

  @Column({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
}
