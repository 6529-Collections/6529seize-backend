import {
  openAiAbusivenessDetectionService,
  OpenAiAbusivenessDetectionService
} from '../open-ai-abusiveness-detection.service';
import { abusivenessCheckDb, AbusivenessCheckDb } from './abusiveness-check.db';
import { BadRequestException } from '../exceptions';
import {
  AbusivenessDetectionResult,
  REP_CATEGORY_PATTERN
} from '../entities/IAbusivenessDetectionResult';

export class AbusivenessCheckService {
  constructor(
    private readonly openAiAbusivenessDetectionService: OpenAiAbusivenessDetectionService,
    private readonly abusivenessCheckDb: AbusivenessCheckDb
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
    const result =
      await this.openAiAbusivenessDetectionService.checkRepPhraseText(txt);
    await this.abusivenessCheckDb.saveResult(result);
    return result;
  }

  async checkBio(text: string): Promise<AbusivenessDetectionResult> {
    const txt = text.trim();
    if (txt.length > 500) {
      throw new BadRequestException(`Text must be up to 500 characters`);
    }
    return await this.openAiAbusivenessDetectionService.checkBioText(txt);
  }
}

export const abusivenessCheckService = new AbusivenessCheckService(
  openAiAbusivenessDetectionService,
  abusivenessCheckDb
);
