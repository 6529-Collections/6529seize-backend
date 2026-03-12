import { Entity, PrimaryColumn } from 'typeorm';
import { MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE } from '@/constants';

@Entity(MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE)
export class MintEndAnnouncementsDoneMemeToken {
  @PrimaryColumn({ type: 'int' })
  readonly id: number;
}
