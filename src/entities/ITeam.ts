import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity()
export class Team {
  @CreateDateColumn({ type: 'datetime' })
  created_at!: Date;

  @PrimaryColumn({ type: 'varchar', length: 50 })
  wallet!: string;

  @Column({ type: 'text' })
  collection!: string;

  @Column({ type: 'text' })
  name!: string;
}
