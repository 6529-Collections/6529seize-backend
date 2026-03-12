import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { DeployerDropper, deployerDropper } from '@/deployer-dropper';
import { Env, env } from '@/env';
import {
  ManifoldClaimService,
  manifoldClaimService
} from './manifold-claim.service';
import { getNewestMeme } from '@/nftsLoop/db.nfts';
import { sqlExecutor } from '@/sql-executor';
import {
  MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
  MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE
} from '@/constants';

interface PhaseConfig {
  readonly name: string;
  readonly startHour: number;
  readonly startMinute: number;
  readonly closeDayOffset: number;
  readonly closeHour: number;
  readonly closeMinute: number;
}

interface MintEndSchedule {
  readonly daysOfWeek: readonly number[];
  readonly hour: number;
  readonly minute: number;
}

type AnnouncementWindow =
  | { readonly type: 'PHASE'; readonly phase: PhaseConfig }
  | { readonly type: 'MINT_END' };

const EUROPE_TZ = 'Europe/Athens'; // EET/EEST

const PHASES: readonly PhaseConfig[] = [
  {
    name: 'Phase 0',
    startHour: 17,
    startMinute: 40,
    closeDayOffset: 0,
    closeHour: 18,
    closeMinute: 20
  },
  {
    name: 'Phase 1',
    startHour: 18,
    startMinute: 30,
    closeDayOffset: 0,
    closeHour: 18,
    closeMinute: 50
  },
  {
    name: 'Phase 2',
    startHour: 19,
    startMinute: 0,
    closeDayOffset: 0,
    closeHour: 19,
    closeMinute: 20
  },
  {
    name: 'Public Phase',
    startHour: 19,
    startMinute: 20,
    closeDayOffset: 1,
    closeHour: 17,
    closeMinute: 0
  }
];

const MAX_MINUTES_AFTER_PHASE_START = Time.minutes(5);
const MINT_END_SCHEDULE: MintEndSchedule = {
  // Tue/Thu/Sat in moment day() numbering (0=Sun)
  daysOfWeek: [2, 4, 6],
  hour: 17,
  minute: 0
};

export class AnnounceMintStateChangeUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly deployerDropper: DeployerDropper,
    private readonly manifoldClaimService: ManifoldClaimService,
    private readonly env: Env
  ) {}

  async handle(ctx: RequestContext): Promise<void> {
    try {
      ctx.timer?.start(`${this.constructor.name}->handle`);
      const announcementWindow = this.findAnnouncementWindow();

      if (!announcementWindow) {
        this.logger.info(
          'No active announcement window found within the allowed time window'
        );
        return;
      }

      const mintingMeme = await getNewestMeme();
      if (!mintingMeme?.id) {
        throw new Error('No meme tokens found');
      }
      const phaseAnnouncementsDoneForThisToken = await this.isAnnouncementDone(
        MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
        mintingMeme.id
      );
      const mintEndAnnouncementDoneForThisToken = await this.isAnnouncementDone(
        MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
        mintingMeme.id
      );
      if (
        announcementWindow.type === 'PHASE' &&
        phaseAnnouncementsDoneForThisToken
      ) {
        this.logger.info(
          `All phase mint announcements are already done for token #${mintingMeme.id}`
        );
        return;
      }
      if (
        announcementWindow.type === 'MINT_END' &&
        mintEndAnnouncementDoneForThisToken
      ) {
        this.logger.info(
          `End-of-mint announcement is already done for token #${mintingMeme.id}`
        );
        return;
      }
      const { minted, total, remaining } =
        await this.manifoldClaimService.getMintStatsFromMemeClaim(
          mintingMeme.id,
          ctx
        );
      const waves = this.env.getStringArray('DEPLOYER_ANNOUNCEMENTS_WAVE_IDS');
      let message = `Meme #${mintingMeme.id}`;
      if (mintingMeme.name) {
        message += ` - ${mintingMeme.name}`;
      }
      const mentionedUsers: string[] = [];
      const cardPage = (
        this.env.getStringOrNull(`FE_MEMES_CARD_PAGE_URL_TEMPLATE`) ??
        'https://6529.io/the-memes/{cardNo}'
      ).replace('{cardNo}', mintingMeme.id.toString());
      message += `\n\n${cardPage}`;
      const cardSoldOut = remaining <= 0;
      if (announcementWindow.type === 'MINT_END') {
        message += `\n\nMinting Completed`;
        message += `\nClosing Edition Size: ${minted}`;
      } else if (cardSoldOut) {
        message += `\n\nMint Complete!`;
        message += `\n\nEdition fully minted 🚀🚀🚀`;
        const artistHandles = mintingMeme.artist_seize_handle
          .split(',')
          .map((it) => it.trim());
        message += `\n\nGG ${artistHandles
          .map((it) => `@[${it}]`)
          .join(', ')} and all the minters :sgt_pinched_fingers:`;
        mentionedUsers.push(...artistHandles);
      } else {
        message += `\n\n${announcementWindow.phase.name} is Live!`;
        message += `\nEdition Size: ${total}`;
        message += `\nRemaining: ${remaining}`;
        message += `\n\nMinting for this phase closes ${this.getPhaseCloseAtUtcString(announcementWindow.phase)}`;
      }
      this.logger.info(message);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          await this.deployerDropper.drop(
            { message, mentionedUsers, waves },
            ctxWithConnection
          );
          if (announcementWindow.type === 'PHASE' && cardSoldOut) {
            await sqlExecutor.execute(
              `insert into ${MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE} (id) values (:id)`,
              { id: mintingMeme.id },
              { wrappedConnection: connection }
            );
          }
          if (announcementWindow.type === 'MINT_END') {
            await sqlExecutor.execute(
              `insert into ${MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE} (id) values (:id)`,
              { id: mintingMeme.id },
              { wrappedConnection: connection }
            );
          }
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
  }

  private async isAnnouncementDone(
    table: string,
    memeTokenId: number
  ): Promise<boolean> {
    return (
      (await sqlExecutor.oneOrNull<{ id: number }>(
        `select id from ${table} where id = :id`,
        { id: memeTokenId }
      )) != null
    );
  }

  private findAnnouncementWindow(): AnnouncementWindow | null {
    const phase = this.findCurrentPhase();
    if (phase) {
      return { type: 'PHASE', phase };
    }
    if (this.isMintEndWindow()) {
      return { type: 'MINT_END' };
    }
    return null;
  }

  private findCurrentPhase(): PhaseConfig | null {
    const now = Time.nowInTimezone(EUROPE_TZ);
    const todayMidnightTz = Time.todayMidnightInTimezone(EUROPE_TZ);
    let matchedPhase: PhaseConfig | null = null;
    let smallestDiffMs: number | null = null;
    const maxMinutesAfterPhaseStartMs =
      MAX_MINUTES_AFTER_PHASE_START.toMillis();
    for (const phase of PHASES) {
      const phaseStart = todayMidnightTz
        .clone()
        .hour(phase.startHour)
        .minute(phase.startMinute)
        .second(0)
        .millisecond(0);
      const timeSincePhaseStartMs = now.valueOf() - phaseStart.valueOf();

      if (
        timeSincePhaseStartMs >= 0 &&
        timeSincePhaseStartMs < maxMinutesAfterPhaseStartMs
      ) {
        if (smallestDiffMs === null || timeSincePhaseStartMs < smallestDiffMs) {
          smallestDiffMs = timeSincePhaseStartMs;
          matchedPhase = phase;
        }
      }
    }

    return matchedPhase;
  }

  private isMintEndWindow(): boolean {
    const now = Time.nowInTimezone(EUROPE_TZ);
    if (!MINT_END_SCHEDULE.daysOfWeek.includes(now.day())) {
      return false;
    }
    const mintEndStart = now
      .clone()
      .startOf('day')
      .hour(MINT_END_SCHEDULE.hour)
      .minute(MINT_END_SCHEDULE.minute)
      .second(0)
      .millisecond(0);
    const msSinceMintEndStart = now.valueOf() - mintEndStart.valueOf();
    return (
      msSinceMintEndStart >= 0 &&
      msSinceMintEndStart < MAX_MINUTES_AFTER_PHASE_START.toMillis()
    );
  }

  private getPhaseCloseAtUtcString(phase: PhaseConfig): string {
    const closeLocal = Time.todayMidnightInTimezone(EUROPE_TZ)
      .add(phase.closeDayOffset, 'day')
      .hour(phase.closeHour)
      .minute(phase.closeMinute)
      .second(0)
      .millisecond(0);
    const closeUtc = closeLocal.clone().utc();

    if (phase.closeDayOffset === 0) {
      return `at ${closeUtc.format('HH:mm')} UTC`;
    }
    if (phase.closeDayOffset === 1) {
      return `tomorrow at ${closeUtc.format('HH:mm')} UTC`;
    }
    return `on ${closeUtc.format('YYYY-MM-DD HH:mm')} UTC`;
  }
}

export const announceMintStateChangeUseCase =
  new AnnounceMintStateChangeUseCase(
    deployerDropper,
    manifoldClaimService,
    env
  );
