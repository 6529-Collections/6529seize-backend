import {
  AiBasedAbusivenessDetector,
  aiBasedAbusivenessDetector
} from '../abusinveness/ai-based-abusiveness.detector';
import { abusivenessCheckDb, AbusivenessCheckDb } from './abusiveness-check.db';
import { BadRequestException } from '../exceptions';
import {
  AbusivenessDetectionResult,
  REP_CATEGORY_PATTERN
} from '../entities/IAbusivenessDetectionResult';
import { discord, Discord, DiscordChannel } from '../discord';
import { Logger } from '../logging';

export class AbusivenessCheckService {
  private logger = Logger.get(AbusivenessCheckService.name);

  constructor(
    private readonly openAiAbusivenessDetectionService: AiBasedAbusivenessDetector,
    private readonly abusivenessCheckDb: AbusivenessCheckDb,
    private readonly discord: Discord
  ) {}

  async checkRepPhrase(text: string): Promise<AbusivenessDetectionResult> {
    const txt = text.trim();
    if (txt.length === 0 || txt.length > 100) {
      throw new BadRequestException(`Text must be 1-100 characters`);
    }
    if (!REP_CATEGORY_PATTERN.exec(txt)) {
      throw new BadRequestException(
        `Rep statement contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.`
      );
    }
    const existingResult = await this.abusivenessCheckDb.findResult(txt);
    if (existingResult) {
      return existingResult;
    }
    try {
      const result =
        await this.openAiAbusivenessDetectionService.checkRepPhraseText(txt);
      await this.abusivenessCheckDb.saveResult(result);
      return result;
    } catch (e) {
      this.logger.error('OpenAI check threw an error');
      this.logger.error(e);
      await this.discord.sendMessage(
        DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
        `Rep phrase: ${txt}\n\nOpenAI check failed with error: ${e}`
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
    return await this.openAiAbusivenessDetectionService.checkBioText({
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
    return await this.openAiAbusivenessDetectionService.checkCurationName({
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
