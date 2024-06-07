import { Entity, PrimaryColumn } from 'typeorm';
import { WALLET_GROUPS_TABLE } from '../constants';

@Entity(WALLET_GROUPS_TABLE)
export class WalletGroupEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 50,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly wallet_group_id!: string;
  @PrimaryColumn({
    type: 'varchar',
    length: 50,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly wallet!: string;
}
