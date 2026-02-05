import { Entity, PrimaryColumn } from 'typeorm';
import { MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE } from '@/constants';

@Entity(MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE)
export class MintAnnouncementsDoneMemeToken {
  @PrimaryColumn({ type: 'int' })
  readonly id: number;
}
