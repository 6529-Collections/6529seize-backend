import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity()
export class RoyaltiesUpload {
  @CreateDateColumn({ type: 'datetime' })
  created_at?: Date;

  @PrimaryColumn({ type: 'date' })
  date!: Date;

  @Column({ type: 'text' })
  url!: string;
}
