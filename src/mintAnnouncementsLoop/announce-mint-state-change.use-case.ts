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
  MINT_END_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
  PUBLIC_PHASE_ENDING_SOON_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE
} from '@/constants';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';

interface PhaseConfig {
  readonly name: string;
  readonly startHour: number;
  readonly startMinute: number;
  readonly closeDayOffset: number;
  readonly closeHour: number;
  readonly closeMinute: number;
}

interface AnnouncementSchedule {
  readonly daysOfWeek: readonly number[];
  readonly hour: number;
  readonly minute: number;
}

type AnnouncementWindow =
  | { readonly type: 'PHASE'; readonly phase: PhaseConfig }
  | { readonly type: 'PUBLIC_PHASE_ENDING_SOON' }
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

const ANNOUNCEMENT_WINDOW_DURATION_MINUTES = Time.minutes(5);
const PUBLIC_PHASE_ENDING_SOON_SCHEDULE: AnnouncementSchedule = {
  // Tue/Thu/Sat in moment day() numbering (0=Sun)
  daysOfWeek: [2, 4, 6],
  hour: 16,
  minute: 0
};
const MINT_END_SCHEDULE: AnnouncementSchedule = {
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
      const publicPhaseEndingSoonAnnouncementDoneForThisToken =
        await this.isAnnouncementDone(
          PUBLIC_PHASE_ENDING_SOON_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE,
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
      if (
        announcementWindow.type === 'PUBLIC_PHASE_ENDING_SOON' &&
        publicPhaseEndingSoonAnnouncementDoneForThisToken
      ) {
        this.logger.info(
          `Public phase ending soon announcement is already done for token #${mintingMeme.id}`
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
      if (announcementWindow.type === 'PUBLIC_PHASE_ENDING_SOON') {
        if (cardSoldOut) {
          this.logger.info(
            `Skipping public phase ending soon announcement for token #${mintingMeme.id} because mint is already complete`
          );
          return;
        }
        message += `\n\nPublic Phase ends in 1 hour!`;
        message += `\nEdition Size: ${total}`;
        message += `\nRemaining: ${remaining}`;
        message += `\n\nMinting closes ${this.getPublicPhaseCloseAtUtcString()}`;
      } else if (announcementWindow.type === 'MINT_END') {
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
      const pendingPushNotificationIds =
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctxWithConnection = { ...ctx, connection };
            const pendingPushNotificationIds = await this.deployerDropper.drop(
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
            if (announcementWindow.type === 'PUBLIC_PHASE_ENDING_SOON') {
              await sqlExecutor.execute(
                `insert into ${PUBLIC_PHASE_ENDING_SOON_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE} (id) values (:id)`,
                { id: mintingMeme.id },
                { wrappedConnection: connection }
              );
            }
            return pendingPushNotificationIds;
          }
        );
      await sendIdentityPushNotifications(pendingPushNotificationIds);
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
    if (this.isPublicPhaseEndingSoonWindow()) {
      return { type: 'PUBLIC_PHASE_ENDING_SOON' };
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
      ANNOUNCEMENT_WINDOW_DURATION_MINUTES.toMillis();
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

  private isPublicPhaseEndingSoonWindow(): boolean {
    return this.isScheduledWindow(PUBLIC_PHASE_ENDING_SOON_SCHEDULE);
  }

  private isMintEndWindow(): boolean {
    return this.isScheduledWindow(MINT_END_SCHEDULE);
  }

  private isScheduledWindow(schedule: AnnouncementSchedule): boolean {
    const now = Time.nowInTimezone(EUROPE_TZ);
    if (!schedule.daysOfWeek.includes(now.day())) {
      return false;
    }
    const start = now
      .clone()
      .startOf('day')
      .hour(schedule.hour)
      .minute(schedule.minute)
      .second(0)
      .millisecond(0);
    const msSinceStart = now.valueOf() - start.valueOf();
    return (
      msSinceStart >= 0 &&
      msSinceStart < ANNOUNCEMENT_WINDOW_DURATION_MINUTES.toMillis()
    );
  }

  private getPublicPhaseCloseAtUtcString(): string {
    const closeLocal = Time.todayMidnightInTimezone(EUROPE_TZ)
      .hour(MINT_END_SCHEDULE.hour)
      .minute(MINT_END_SCHEDULE.minute)
      .second(0)
      .millisecond(0);
    const closeUtc = closeLocal.clone().utc();
    return `at ${closeUtc.format('HH:mm')} UTC`;
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
