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
import { MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE } from '@/constants';

interface PhaseConfig {
  readonly name: string;
  readonly startHour: number;
  readonly startMinute: number;
  readonly closesAt: string;
}

const PHASES: readonly PhaseConfig[] = [
  { name: 'Phase0', startHour: 15, startMinute: 40, closesAt: 'at 16:20' },
  { name: 'Phase1', startHour: 16, startMinute: 30, closesAt: 'at 16:50' },
  { name: 'Phase2', startHour: 17, startMinute: 0, closesAt: 'at 17:20' },
  {
    name: 'Public Phase',
    startHour: 17,
    startMinute: 20,
    closesAt: 'tomorrow at 15:00'
  }
];

const MAX_MINUTES_AFTER_PHASE_START = Time.minutes(5);

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
      const currentPhase = this.findCurrentPhase();

      if (!currentPhase) {
        this.logger.info(
          'No active phase found within the allowed time window'
        );
        return;
      }

      const mintingMeme = await getNewestMeme();
      if (!mintingMeme?.id) {
        throw new Error('No meme tokens found');
      }
      const mintAnnouncementsDoneForThisToken =
        (await sqlExecutor.oneOrNull<{ id: number }>(
          `select id from ${MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE} where id = :id`,
          { id: mintingMeme.id }
        )) != null;
      if (mintAnnouncementsDoneForThisToken) {
        this.logger.info(
          `All mint announcements are already done for token #${mintingMeme.id}`
        );
        return;
      }
      const { total, remaining } =
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
      if (cardSoldOut) {
        message += `\n\nMint Complete!`;
        message += `\n\nEdition got fully minted before the public phase 🚀🚀🚀`;
        const artistHandles = mintingMeme.artist_seize_handle
          .split(',')
          .map((it) => it.trim());
        message += `\n\nGG ${artistHandles
          .map((it) => `@[${it}]`)
          .join(', ')} and all the minters :sgt_pinched_fingers:`;
        mentionedUsers.push(...artistHandles);
      } else {
        message += `\n\n${currentPhase.name} is Live!`;
        message += `\nEdition Size: ${total}`;
        message += `\nRemaining: ${remaining}`;
        message += `\n\nMinting closes ${currentPhase.closesAt} UTC`;
      }
      this.logger.info(message);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          await this.deployerDropper.drop(
            { message, mentionedUsers, waves },
            ctxWithConnection
          );
          if (cardSoldOut) {
            await sqlExecutor.execute(
              `insert into ${MINT_ANNOUNCEMENTS_DONE_MEME_TOKENS_TABLE} (id) values (:id)`,
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

  private findCurrentPhase(): PhaseConfig | null {
    const todayMidnightUtc = Time.todayUtcMidnight();
    let matchedPhase: PhaseConfig | null = null;
    let smallestDiff: Time | null = null;
    const now = Time.now();
    for (const phase of PHASES) {
      const phaseStart = todayMidnightUtc
        .plusHours(phase.startHour)
        .plusMinutes(phase.startMinute);

      const timeSincePhaseStart = now.minus(phaseStart);

      if (
        now.gte(phaseStart) &&
        timeSincePhaseStart.lt(MAX_MINUTES_AFTER_PHASE_START)
      ) {
        if (smallestDiff === null || timeSincePhaseStart.lt(smallestDiff)) {
          smallestDiff = timeSincePhaseStart;
          matchedPhase = phase;
        }
      }
    }

    return matchedPhase;
  }
}

export const announceMintStateChangeUseCase =
  new AnnounceMintStateChangeUseCase(
    deployerDropper,
    manifoldClaimService,
    env
  );
