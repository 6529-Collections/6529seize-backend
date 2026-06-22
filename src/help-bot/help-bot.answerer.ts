import { Logger } from '@/logging';
import {
  frontendHelpBotKnowledgeSource,
  HelpBotKnowledgeSource,
  HelpBotKnowledgeRecord,
  HelpBotKnowledgeMatch
} from './help-bot.knowledge';
import {
  HelpBotCalendarService,
  isCalendarTimingQuestion
} from './help-bot-calendar.service';
import { HelpBotPublicDataService } from './help-bot-public-data.service';
import {
  ensureCanonicalMarkdownLink,
  stripHelpBotSelfIntro
} from './help-bot-response-text';
import {
  isHelpBotContextVerificationQuestion,
  parseHelpBotQuestionContext
} from './help-bot-question-context';

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
  readonly calendarQueryId?: string;
  readonly escalateToTechTeam?: boolean;
}

export interface HelpBotNoReliableSource {
  readonly type: 'NO_RELIABLE_SOURCE';
  readonly escalateToTechTeam: boolean;
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

function hasRoutePlaceholder(path: string): boolean {
  return /[{}]|%7B|%7D/i.test(path);
}

function safeCanonicalPath(record: HelpBotKnowledgeRecord): string {
  if (!hasRoutePlaceholder(record.canonicalPath)) {
    return record.canonicalPath;
  }
  return (
    record.relatedPaths.find((path) => !hasRoutePlaceholder(path)) ?? '/network'
  );
}

function buildDeterministicAnswer(
  record: HelpBotKnowledgeRecord,
  canonicalUrl: string
): string {
  return ensureCanonicalMarkdownLink({
    text: record.facts.join(' '),
    canonicalUrl,
    label: record.linkLabel
  });
}

function normalizeRenderedAnswer(
  text: string,
  canonicalUrl: string,
  label: string
): string {
  const withUrl = ensureCanonicalMarkdownLink({
    text: stripHelpBotSelfIntro(text),
    canonicalUrl,
    label
  });
  return withUrl.length <= 1200 ? withUrl : `${withUrl.slice(0, 1197)}...`;
}

function buildPublicDataRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'public-data.query',
    kind: 'public_data',
    title: '6529 public data',
    linkLabel: 'Open Data',
    canonicalPath: '/open-data',
    aliases: ['public data'],
    keywords: ['public', 'data'],
    facts: ['This answer was generated from public 6529 database rows.'],
    relatedPaths: ['/network/tdh', '/the-memes'],
    tags: ['public-data'],
    sourceRefs: ['backend public data query catalog']
  };
}

function buildCalendarRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'meme-calendar.query',
    kind: 'public_data',
    title: 'Memes minting calendar',
    linkLabel: 'Memes Calendar',
    canonicalPath: '/meme-calendar',
    aliases: ['meme calendar', 'next drop', 'next mint'],
    keywords: ['memes', 'calendar', 'mint', 'drop', 'schedule'],
    facts: ['This answer was generated from the public Memes calendar API.'],
    relatedPaths: ['/the-memes/mint'],
    tags: ['memes', 'calendar'],
    sourceRefs: ['frontend meme calendar API']
  };
}

function buildBoundaryRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.boundary.playful',
    kind: 'guardrail',
    title: 'Help bot boundary',
    linkLabel: 'Waves',
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

function buildCapabilitiesRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.capabilities',
    kind: 'guardrail',
    title: 'Help bot capabilities',
    linkLabel: 'Waves',
    canonicalPath: '/waves',
    aliases: ['help bot capabilities'],
    keywords: ['help', 'capabilities'],
    facts: [
      'The help bot can answer public 6529 product questions and ask for a topic when the user only asks for help.'
    ],
    relatedPaths: [],
    tags: ['help-bot', 'guardrail'],
    sourceRefs: ['backend help bot capability classifier']
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

function isGenericHelpRequest(normalizedQuestion: string): boolean {
  return [
    /^(help|help me|i need help|need help|help please|please help)$/,
    /^(can|could|would) you help( me)?$/,
    /^what (can|could) you (do|help with|answer)$/,
    /^what do you do$/,
    /^how (can|could|do) you help( me)?$/,
    /^what should i ask( you)?$/,
    /^what questions can i ask( you)?$/,
    /^(show me )?(help|options|commands|menu)$/
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
    'card',
    'cards',
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

const PRODUCT_CONTEXT_PATTERNS = [
  /\b6529\b/,
  /\bseize\b/,
  /\btdh\b/,
  /\bxtdh\b/,
  /\brep\b/,
  /\bcic\b/,
  /\bnic\b/,
  /\bwave(s)?\b/,
  /\bdrop(s)?\b/,
  /\bthe memes\b/,
  /\bmeme card(s)?\b/,
  /\bcard(s)?\b/,
  /\bmeme lab\b/,
  /\bnextgen\b/,
  /\brememe(s)?\b/,
  /\bdrop forge\b/,
  /\bsubscription(s)?\b/,
  /\beligibility\b/,
  /\bprofile(s)?\b/,
  /\bgroup(s)?\b/,
  /\bdelegation(s)?\b/,
  /\bdelegation manager(s)?\b/,
  /\bconsolidat(e|ed|es|ing|ion|ions)\b/,
  /\bprimary address\b/,
  /\bopen data\b/,
  /\bapi tool(s)?\b/,
  /\b6529bot\b/,
  /\bbadge(s)?\b/,
  /\bnetwork\b/,
  /\bgradients?\b/,
  /\bmuseum\b/,
  /\ballowlist\b/,
  /\bmint(ing)?\b/,
  /\bwallet connection\b/,
  /\bconnect wallet\b/,
  /\brank wave\b/,
  /\bapprove wave\b/,
  /\bchat wave\b/,
  /\b6529\.io\b/
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const CONTEXTUAL_FOLLOW_UP_PATTERN =
  /\b(it|that|this|there|eligibility|rules|button|page|link|tab|menu|create|find|open|where|how)\b/;

const WEAK_MATCH_SCORE_MAX = 4;
const WEAK_MATCH_PREFIX =
  "I might not be fully sure on this one, so here's my best answer.";

const DEFINITION_QUESTION_PREFIXES = [
  'what is',
  'what are',
  'what does',
  'what do',
  'what s',
  'whats',
  'define',
  'explain',
  'describe',
  'tell me about'
];

const DEFINITION_QUESTION_SUFFIXES = [
  'stand for',
  'stands for',
  'mean',
  'means'
];

function stripDefinitionQuestionWords(value: string): string {
  let stripped = value.trim();
  for (const prefix of DEFINITION_QUESTION_PREFIXES) {
    if (stripped === prefix) {
      return '';
    }
    if (stripped.startsWith(`${prefix} `)) {
      stripped = stripped.slice(prefix.length + 1).trim();
      break;
    }
  }
  for (const suffix of DEFINITION_QUESTION_SUFFIXES) {
    if (stripped === suffix) {
      return '';
    }
    if (stripped.endsWith(` ${suffix}`)) {
      stripped = stripped.slice(0, -(suffix.length + 1)).trim();
      break;
    }
  }
  return stripped;
}

function isExactDefinitionMatch(
  question: string,
  record: HelpBotKnowledgeRecord
): boolean {
  const normalizedQuestion = stripDefinitionQuestionWords(
    normalizeBoundaryText(question)
  );
  if (!normalizedQuestion) {
    return false;
  }
  const exactTerms = [record.title, ...record.aliases, ...record.keywords].map(
    (term) => normalizeBoundaryText(term)
  );

  return exactTerms.some((term) => term === normalizedQuestion);
}

function containsExactKnowledgeTerm(
  text: string,
  record: HelpBotKnowledgeRecord
): boolean {
  const normalizedText = normalizeBoundaryText(text);
  const exactTerms = [record.title, ...record.aliases].map((term) =>
    normalizeBoundaryText(term)
  );
  return exactTerms.some((term) => {
    if (!term) {
      return false;
    }
    return new RegExp(`(^|\\s)${escapeRegExp(term)}(\\s|$)`).test(
      normalizedText
    );
  });
}

function isStrongContextVerificationMatch(
  question: string,
  record: HelpBotKnowledgeRecord
): boolean {
  const parsedQuestion = parseHelpBotQuestionContext(question);
  return (
    !!parsedQuestion.repliedToDropContext &&
    isHelpBotContextVerificationQuestion(parsedQuestion.primaryQuestion) &&
    containsExactKnowledgeTerm(parsedQuestion.repliedToDropContext, record)
  );
}

function isWeakKnowledgeMatch(match: HelpBotKnowledgeMatch): boolean {
  return match.score <= WEAK_MATCH_SCORE_MAX;
}

function appendWeakMatchPrefix(answer: string): string {
  return `${WEAK_MATCH_PREFIX}\n\n${answer}`;
}

function isLikelyProductText(value: string | null | undefined): boolean {
  const normalized = normalizeBoundaryText(value ?? '');
  return PRODUCT_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLikelyProductQuestion(
  question: string,
  previousBotAnswer?: string | null
): boolean {
  if (isLikelyProductText(question)) {
    return true;
  }
  return (
    !!previousBotAnswer &&
    CONTEXTUAL_FOLLOW_UP_PATTERN.test(normalizeBoundaryText(question)) &&
    isLikelyProductText(previousBotAnswer)
  );
}

function shouldSkipPublicDataMode(question: string): boolean {
  const parsedQuestion = parseHelpBotQuestionContext(question);
  return (
    !!parsedQuestion.repliedToDropContext &&
    isHelpBotContextVerificationQuestion(parsedQuestion.primaryQuestion)
  );
}

function isLikelyDynamicPublicDataQuestion(
  question: string,
  previousBotAnswer?: string | null
): boolean {
  if (shouldSkipPublicDataMode(question)) {
    return false;
  }
  const parsedQuestion = parseHelpBotQuestionContext(question);
  const normalizedQuestion = normalizeBoundaryText(
    parsedQuestion.primaryQuestion
  );
  const normalizedContext = normalizeBoundaryText(
    `${parsedQuestion.primaryQuestion} ${
      parsedQuestion.repliedToDropContext ?? ''
    } ${previousBotAnswer ?? ''}`
  );
  const hasDataIntent = [
    /\bhow many\b/,
    /\bcount\b/,
    /\bhighest\b/,
    /\blowest\b/,
    /\btop\b/,
    /\bmost\b/,
    /\btotal\b/,
    /\bsum\b/,
    /\baverage\b/,
    /\bavg\b/,
    /\bwho has\b/,
    /\bwhich (profile|user|identity)\b/,
    /\bcurrent tdh\b/,
    /\btdh rate\b/,
    /\bhodl rate\b/,
    /\bedition size\b/,
    /\bsupply\b/,
    /\bszn\b/,
    /\bseason\b/
  ].some((pattern) => pattern.test(normalizedQuestion));
  if (!hasDataIntent) {
    return false;
  }
  return [
    /\btdh\b/,
    /\bmeme(s)?\b/,
    /\bcard(s)?\b/,
    /\bnft(s)?\b/,
    /\bprofile(s)?\b/,
    /\buser(s)?\b/,
    /\bidentit(y|ies)\b/,
    /\bszn\b/,
    /\bseason\b/,
    /\bedition\b/,
    /\bsupply\b/
  ].some((pattern) => pattern.test(normalizedContext));
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

function buildGenericHelpAnswer(question: string): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!isGenericHelpRequest(normalizedQuestion)) {
    return null;
  }
  return 'What do you need help with? I can answer public 6529 product questions about TDH, Waves, delegation, consolidations, subscriptions, drops, profiles, The Memes, public data, and where to find things on 6529.io. Reply with a topic or question.';
}

export class HelpBotAnswerer {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly renderer?: HelpBotLlmRenderer | null,
    private readonly knowledgeSource: HelpBotKnowledgeSource = frontendHelpBotKnowledgeSource,
    private readonly publicDataService?: HelpBotPublicDataService | null,
    private readonly calendarService?: HelpBotCalendarService | null
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

    const genericHelpAnswer = buildGenericHelpAnswer(request.question);
    if (genericHelpAnswer) {
      return {
        type: 'ANSWER',
        answer: genericHelpAnswer,
        record: buildCapabilitiesRecord()
      };
    }

    const expectsCalendarAnswer = isCalendarTimingQuestion(
      request.question,
      request.previousBotAnswer
    );
    const calendarAnswer = await this.answerFromCalendar(
      request,
      expectsCalendarAnswer
    );
    if (calendarAnswer) {
      return {
        type: 'ANSWER',
        answer: calendarAnswer.answer,
        record: buildCalendarRecord(),
        calendarQueryId: calendarAnswer.queryId
      };
    }
    if (expectsCalendarAnswer) {
      return {
        type: 'NO_RELIABLE_SOURCE',
        escalateToTechTeam: true
      };
    }

    const expectsPublicDataAnswer = isLikelyDynamicPublicDataQuestion(
      request.question,
      request.previousBotAnswer
    );
    const publicDataAnswer = shouldSkipPublicDataMode(request.question)
      ? null
      : await this.answerFromPublicData(request, expectsPublicDataAnswer);
    if (publicDataAnswer) {
      return {
        type: 'ANSWER',
        answer: publicDataAnswer.answer,
        record: buildPublicDataRecord(),
        publicDataQueryId: publicDataAnswer.queryId
      };
    }
    if (expectsPublicDataAnswer) {
      return {
        type: 'NO_RELIABLE_SOURCE',
        escalateToTechTeam: true
      };
    }

    const match = await this.findKnowledgeMatch(request);
    if (!match) {
      return {
        type: 'NO_RELIABLE_SOURCE',
        escalateToTechTeam: isLikelyProductQuestion(
          request.question,
          request.previousBotAnswer
        )
      };
    }

    const exactDefinitionMatch = isExactDefinitionMatch(
      request.question,
      match.record
    );
    const strongContextVerificationMatch = isStrongContextVerificationMatch(
      request.question,
      match.record
    );
    const escalateToTechTeam =
      isWeakKnowledgeMatch(match) &&
      !exactDefinitionMatch &&
      !strongContextVerificationMatch &&
      isLikelyProductQuestion(request.question, request.previousBotAnswer);

    const canonicalUrl = toCanonicalUrl(
      request.baseUrl,
      safeCanonicalPath(match.record)
    );

    const maybeWithWeakCaveat = (answer: string) =>
      escalateToTechTeam ? appendWeakMatchPrefix(answer) : answer;

    if (!this.renderer) {
      return {
        type: 'ANSWER',
        answer: maybeWithWeakCaveat(
          buildDeterministicAnswer(match.record, canonicalUrl)
        ),
        record: match.record,
        escalateToTechTeam
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
          answer: maybeWithWeakCaveat(
            normalizeRenderedAnswer(
              rendered,
              canonicalUrl,
              match.record.linkLabel
            )
          ),
          record: match.record,
          escalateToTechTeam
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
      answer: maybeWithWeakCaveat(
        buildDeterministicAnswer(match.record, canonicalUrl)
      ),
      record: match.record,
      escalateToTechTeam
    };
  }

  private async answerFromCalendar(
    request: HelpBotAnswerRequest,
    expectsCalendarAnswer: boolean
  ) {
    try {
      return (
        (await this.calendarService?.answer({
          question: request.question,
          previousBotAnswer: request.previousBotAnswer,
          baseUrl: request.baseUrl
        })) ?? null
      );
    } catch (error) {
      if (expectsCalendarAnswer) {
        this.logger.warn('Help bot calendar answer failed', error);
        return null;
      }
      throw error;
    }
  }

  private async answerFromPublicData(
    request: HelpBotAnswerRequest,
    expectsPublicDataAnswer: boolean
  ) {
    try {
      return (
        (await this.publicDataService?.answer({
          question: request.question,
          previousBotAnswer: request.previousBotAnswer
        })) ?? null
      );
    } catch (error) {
      if (expectsPublicDataAnswer) {
        this.logger.warn('Help bot public data answer failed', error);
        return null;
      }
      throw error;
    }
  }

  private async findKnowledgeMatch(
    request: HelpBotAnswerRequest
  ): Promise<HelpBotKnowledgeMatch | null> {
    try {
      const directMatch = await this.knowledgeSource.findMatch(
        request.question
      );
      const contextualMatch = request.previousBotAnswer
        ? await this.knowledgeSource.findMatch(
            [request.question, request.previousBotAnswer].join('\n')
          )
        : null;
      return directMatch ?? contextualMatch;
    } catch (error) {
      this.logger.warn('Help bot knowledge source failed', error);
      return null;
    }
  }
}
