import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ADDRESS_CONSOLIDATION_KEY } from '@/constants';

@Entity(ADDRESS_CONSOLIDATION_KEY)
export class AddressConsolidationKey {
  @PrimaryColumn({ type: 'varchar', length: 50, nullable: false })
  public readonly address!: string;
  @Index('address_consolidation_key_idx')
  @Column({ type: 'varchar', length: 200, nullable: false })
  public readonly consolidation_key!: string;
}
