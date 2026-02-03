import { Column, Entity, PrimaryColumn } from 'typeorm';
import { CIC_STATEMENTS_TABLE } from '@/constants';

@Entity(CIC_STATEMENTS_TABLE)
export class CicStatement {
  @PrimaryColumn({ type: 'varchar', length: 40, nullable: false })
  id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  profile_id!: string;

  @Column({ type: 'varchar', length: 250, nullable: false })
  statement_group!: CicStatementGroup;

  @Column({ type: 'varchar', length: 250, nullable: false })
  statement_type!: string;

  @Column({ type: 'text', nullable: true })
  statement_comment!: string | null;

  @Column({ type: 'text', nullable: false })
  statement_value!: string;

  @Column({ type: 'datetime', nullable: false })
  crated_at!: Date;
}

export enum CicStatementGroup {
  GENERAL = 'GENERAL',
  CONTACT = 'CONTACT',
  SOCIAL_MEDIA_ACCOUNT = 'SOCIAL_MEDIA_ACCOUNT',
  NFT_ACCOUNTS = 'NFT_ACCOUNTS',
  SOCIAL_MEDIA_VERIFICATION_POST = 'SOCIAL_MEDIA_VERIFICATION_POST'
}
