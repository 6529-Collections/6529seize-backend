import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATION_KEY_LENGTH
} from '@/constants';

@Entity(ADDRESS_CONSOLIDATION_KEY)
export class AddressConsolidationKey {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  public readonly address!: string;
  @Index('address_consolidation_key_idx')
  @Column({
    type: 'varchar',
    length: CONSOLIDATION_KEY_LENGTH,
    nullable: false
  })
  public readonly consolidation_key!: string;
}
