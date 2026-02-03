import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';
import { DISTRIBUTION_PHOTO_TABLE } from '@/constants';

@Entity({ name: DISTRIBUTION_PHOTO_TABLE })
export class DistributionPhoto {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at!: Date;

  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int' })
  card_id!: number;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'text' })
  link!: string;
}
