import { Logger } from '@/logging';
import {
  frontendHelpBotKnowledgeSource,
  HelpBotKnowledgeSource,
  HelpBotKnowledgeRecord
} from './help-bot.knowledge';
import { HelpBotPublicDataService } from './help-bot-public-data.service';

export interface HelpBotAnswerRequest {
  readonly question: string;
  readonly baseUrl: string;
  readonly previousBotAnswer?: string | null;
}

export interface HelpBotAnswerSuccess {
  readonly type: 'ANSWER';
  readonly answer: string;
  readonly record: HelpBotKnowledgeRecord;
  readonly publicDataSql?: string;
}

export interface HelpBotNoReliableSource {
  readonly type: 'NO_RELIABLE_SOURCE';
}

export type HelpBotAnswerResult =
  | HelpBotAnswerSuccess
  | HelpBotNoReliableSource;

export interface HelpBotLlmRenderer {
  renderAnswer(input: {
    readonly question: string;
    readonly previousBotAnswer?: string | null;
    readonly record: HelpBotKnowledgeRecord;
    readonly canonicalUrl: string;
  }): Promise<string>;
}

function toCanonicalUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  return `${baseUrl}${normalizedPath}`;
}

function buildDeterministicAnswer(
  record: HelpBotKnowledgeRecord,
  canonicalUrl: string
): string {
  return `${record.facts.join(' ')}\n\nMore info: ${canonicalUrl}`;
}

function normalizeRenderedAnswer(text: string, canonicalUrl: string): string {
  const compact = text.trim().replace(/\n{3,}/g, '\n\n');
  const withUrl = compact.includes(canonicalUrl)
    ? compact
    : `${compact}\n\nMore info: ${canonicalUrl}`;
  return withUrl.length <= 1200 ? withUrl : `${withUrl.slice(0, 1197)}...`;
}

function buildPublicDataRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'public-data.query',
    kind: 'public_data',
    title: '6529 public data',
    canonicalPath: '/open-data',
    aliases: ['public data'],
    keywords: ['public', 'data'],
    facts: ['This answer was generated from public 6529 database rows.'],
    relatedPaths: ['/network/tdh', '/the-memes'],
    tags: ['public-data'],
    sourceRefs: ['backend public data query catalog']
  };
}

export class HelpBotAnswerer {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly renderer?: HelpBotLlmRenderer | null,
    private readonly knowledgeSource: HelpBotKnowledgeSource = frontendHelpBotKnowledgeSource,
    private readonly publicDataService?: HelpBotPublicDataService | null
  ) {}

  public async answer(
    request: HelpBotAnswerRequest
  ): Promise<HelpBotAnswerResult> {
    const publicDataAnswer = await this.publicDataService?.answer({
      question: request.question,
      previousBotAnswer: request.previousBotAnswer
    });
    if (publicDataAnswer) {
      return {
        type: 'ANSWER',
        answer: publicDataAnswer.answer,
        record: buildPublicDataRecord(),
        publicDataSql: publicDataAnswer.sql
      };
    }

    const directMatch = await this.knowledgeSource.findMatch(request.question);
    const contextualMatch = request.previousBotAnswer
      ? await this.knowledgeSource.findMatch(
          [request.question, request.previousBotAnswer].join('\n')
        )
      : null;
    const match = directMatch ?? contextualMatch;
    if (!match) {
      return { type: 'NO_RELIABLE_SOURCE' };
    }

    const canonicalUrl = toCanonicalUrl(
      request.baseUrl,
      match.record.canonicalPath
    );
    if (!this.renderer) {
      return {
        type: 'ANSWER',
        answer: buildDeterministicAnswer(match.record, canonicalUrl),
        record: match.record
      };
    }

    try {
      const rendered = await this.renderer.renderAnswer({
        question: request.question,
        previousBotAnswer: request.previousBotAnswer,
        record: match.record,
        canonicalUrl
      });
      if (rendered.trim()) {
        return {
          type: 'ANSWER',
          answer: normalizeRenderedAnswer(rendered, canonicalUrl),
          record: match.record
        };
      }
    } catch (error) {
      this.logger.warn(
        `Help bot LLM renderer failed; using deterministic answer for ${match.record.id}`,
        error
      );
    }

    return {
      type: 'ANSWER',
      answer: buildDeterministicAnswer(match.record, canonicalUrl),
      record: match.record
    };
  }
}
