import { Entity, PrimaryColumn } from 'typeorm';
import {
  MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
  MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
  PUBLIC_PHASE_ENDING_SOON_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE
} from '@/constants';

@Entity(MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE)
export class MintAnnouncementsDoneMemeToken {
  @PrimaryColumn({ type: 'int' })
  readonly id: number;
}

@Entity(MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE)
export class MintEndAnnouncementsDoneMemeToken {
  @PrimaryColumn({ type: 'int' })
  readonly id: number;
}

@Entity(PUBLIC_PHASE_ENDING_SOON_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE)
export class PublicPhaseEndingSoonAnnouncementsDoneMemeToken {
  @PrimaryColumn({ type: 'int' })
  readonly id: number;
}
