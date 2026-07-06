import {
  AiBasedAbusivenessDetector,
  aiBasedAbusivenessDetector
} from '../abusiveness/ai-based-abusiveness.detector';
import { abusivenessCheckDb, AbusivenessCheckDb } from './abusiveness-check.db';
import { BadRequestException } from '../exceptions';
import { AbusivenessDetectionResult } from '@/entities/IAbusivenessDetectionResult';
import { explainRepCategoryViolation } from './rep-category-rules';
import { discord, Discord, DiscordChannel } from '../discord';
import { Logger } from '../logging';
import { RequestContext } from '../request.context';

export class AbusivenessCheckService {
  private logger = Logger.get(AbusivenessCheckService.name);

  constructor(
    private readonly aiBasedAbusivenessDetector: AiBasedAbusivenessDetector,
    private readonly abusivenessCheckDb: AbusivenessCheckDb,
    private readonly discord: Discord
  ) {}

  async bulkCheckRepPhrases(phrases: string[], ctx: RequestContext) {
    const trimmedPhrases = phrases.map((p) => p.trim());
    for (const txt of trimmedPhrases) {
      const violation = explainRepCategoryViolation(txt);
      if (violation) {
        throw new BadRequestException(`REP category "${txt}": ${violation}`);
      }
    }
    const existingResults = await this.abusivenessCheckDb.findResults(
      phrases,
      ctx
    );
    const nonAllowedPhrase = existingResults.find(
      (r) => r.status !== 'ALLOWED'
    )?.text;
    if (nonAllowedPhrase) {
      throw new BadRequestException(
        `REP phrase "${nonAllowedPhrase}" is not allowed.`
      );
    }
    const uncheckedPhrases = phrases.filter(
      (p) => !existingResults.find((r) => r.text === p)
    );
    ctx.timer?.start(`${this.constructor.name}->bulkCheckRepPhrasesExternal`);
    await Promise.all(
      uncheckedPhrases.map((txt) =>
        this.aiBasedAbusivenessDetector
          .checkRepPhraseText(txt)
          .then(async (aiResult) => {
            await this.abusivenessCheckDb.saveResult(aiResult);
            if (aiResult.status !== 'ALLOWED') {
              throw new BadRequestException(
                `REP phrase "${aiResult.text}" is not allowed.`
              );
            }
          })
      )
    );
    ctx.timer?.stop(`${this.constructor.name}->bulkCheckRepPhrasesExternal`);
  }

  async checkRepPhrase(text: string): Promise<AbusivenessDetectionResult> {
    const txt = text.trim();
    const violation = explainRepCategoryViolation(txt);
    if (violation) {
      throw new BadRequestException(violation);
    }
    const existingResult = await this.abusivenessCheckDb.findResult(txt);
    if (existingResult) {
      return existingResult;
    }
    try {
      const result =
        await this.aiBasedAbusivenessDetector.checkRepPhraseText(txt);
      await this.abusivenessCheckDb.saveResult(result);
      return result;
    } catch (e) {
      this.logger.error('AI abusiveness check threw an error');
      this.logger.error(e);
      await this.discord.sendMessage(
        DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
        `Rep phrase: ${txt}\n\nAI abusiveness check failed with error: ${e}`
      );
      return {
        text: txt,
        status: 'ALLOWED',
        explanation: null,
        external_check_performed_at: new Date()
      };
    }
  }

  async checkBio(query: {
    text: string;
    handle: string;
    profile_type: string;
  }): Promise<AbusivenessDetectionResult> {
    const txt = query.text.trim();
    if (txt.length > 500) {
      throw new BadRequestException(`Text must be up to 500 characters`);
    }
    return await this.aiBasedAbusivenessDetector.checkBioText({
      text: txt,
      handle: query.handle,
      profile_type: query.profile_type
    });
  }

  async checkFilterName(query: {
    text: string;
    handle: string;
  }): Promise<AbusivenessDetectionResult> {
    const txt = query.text.trim();
    if (txt.length > 100) {
      throw new BadRequestException(`Text must be up to 100 characters`);
    }
    return await this.aiBasedAbusivenessDetector.checkUserGroupName({
      text: txt,
      handle: query.handle
    });
  }
}

export const abusivenessCheckService = new AbusivenessCheckService(
  aiBasedAbusivenessDetector,
  abusivenessCheckDb,
  discord
);
