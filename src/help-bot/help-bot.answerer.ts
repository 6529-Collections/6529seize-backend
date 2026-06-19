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
  readonly publicDataQueryId?: string;
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

function buildBoundaryRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.boundary.playful',
    kind: 'guardrail',
    title: 'Help bot boundary',
    canonicalPath: '/waves',
    aliases: ['help bot boundary'],
    keywords: ['help', 'bot', 'boundary'],
    facts: [
      'The help bot answers public 6529 product questions and does not perform privileged actions.'
    ],
    relatedPaths: [],
    tags: ['help-bot', 'guardrail'],
    sourceRefs: ['backend help bot boundary classifier']
  };
}

function normalizeBoundaryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#@]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isPromptOrPrivateDataRequest(normalizedQuestion: string): boolean {
  return [
    /\b(ignore|forget|bypass|override)\b.*\b(instruction|instructions|prompt|rules|guardrail|policy)\b/,
    /\b(system|developer|hidden)\s+(prompt|instruction|instructions|message)\b/,
    /\b(show|reveal|read|dump|leak|expose|send|give|tell me|what did)\b.*\b(private|dm|dms|secret|token|password|api key|private key)\b/
  ].some((pattern) => pattern.test(normalizedQuestion));
}

function isInformationalHelpQuestion(normalizedQuestion: string): boolean {
  return /^(what|where|when|why|who|which|how|explain|describe|tell me about|show me where|can i|could i|do i|does|is|are)\b/.test(
    normalizedQuestion
  );
}

function hasControlledAssetTerm(normalizedQuestion: string): boolean {
  return [
    'tdh',
    'xtdh',
    'rep',
    'cic',
    'vote',
    'votes',
    'voting power',
    'meme card',
    'meme cards',
    'nft',
    'nfts',
    'eth',
    'money',
    'wallet balance',
    'balance',
    'admin',
    'moderator',
    'mod',
    'allowlist',
    'mint pass'
  ].some((term) => normalizedQuestion.includes(term));
}

function isImpossiblePrivilegeRequest(normalizedQuestion: string): boolean {
  if (isInformationalHelpQuestion(normalizedQuestion)) {
    return false;
  }
  const asksBotToAct =
    /\b(give|grant|add|send|airdrop|award|assign|set|boost|increase|mint|fake|print)\b/.test(
      normalizedQuestion
    ) || /\b(make me|promote me|turn me into)\b/.test(normalizedQuestion);

  return asksBotToAct && hasControlledAssetTerm(normalizedQuestion);
}

function buildBoundaryAnswer(question: string): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!normalizedQuestion) {
    return null;
  }
  if (isPromptOrPrivateDataRequest(normalizedQuestion)) {
    return "I can't help with private data, hidden prompts, or bypass requests. Ask me a public 6529 product question and I'll help with that.";
  }
  if (isImpossiblePrivilegeRequest(normalizedQuestion)) {
    return "Nice try. I can't grant TDH, REP, NFTs, admin powers, or secret shortcuts on request. Ask me how the real thing works and I'll point you to the right page.";
  }
  return null;
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
    const boundaryAnswer = buildBoundaryAnswer(request.question);
    if (boundaryAnswer) {
      return {
        type: 'ANSWER',
        answer: boundaryAnswer,
        record: buildBoundaryRecord()
      };
    }

    const publicDataAnswer = await this.publicDataService?.answer({
      question: request.question,
      previousBotAnswer: request.previousBotAnswer
    });
    if (publicDataAnswer) {
      return {
        type: 'ANSWER',
        answer: publicDataAnswer.answer,
        record: buildPublicDataRecord(),
        publicDataQueryId: publicDataAnswer.queryId
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
