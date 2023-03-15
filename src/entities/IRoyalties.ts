import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  CreateDateColumn,
  Index
} from 'typeorm';

@Entity()
@Index(['date', 'contract', 'token_id'], { unique: true })
export class Royalties {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ type: 'date' })
  date!: Date;

  @Column({ type: 'varchar', length: 50 })
  contract!: string;

  @Column({ type: 'int' })
  token_id!: number;

  @Column({ type: 'text' })
  artist!: string;

  @Column({ type: 'double' })
  received_royalties!: number;
}

@Entity()
export class RoyaltiesUpload {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'date' })
  date!: Date;

  @Column({ type: 'text' })
  url!: string;
}
