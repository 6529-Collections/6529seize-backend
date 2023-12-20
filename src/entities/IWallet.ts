import { Column, PrimaryColumn } from 'typeorm';

export interface Wallet {
  readonly address: string;
  readonly ens?: string;
}

export abstract class BaseWallet {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;
}

export abstract class BaseConsolidationKey {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  consolidation_key!: string;

  @Column({ type: 'json', nullable: false })
  wallets?: any;
}
