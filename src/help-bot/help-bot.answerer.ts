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
  formatHelpBotMarkdownLink,
  stripHelpBotSelfIntro
} from './help-bot-response-text';
import {
  isHelpBotContextVerificationQuestion,
  parseHelpBotQuestionContext
} from './help-bot-question-context';
import {
  HELP_BOT_CREDIT_CATEGORY,
  HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
  HELP_BOT_HANDLE,
  HELP_BOT_PROFILE_SETUP_CREDIT_GRANT,
  HELP_BOT_QUESTION_CREDIT_COST,
  HELP_BOT_SIGNUP_CREDIT_GRANT
} from './help-bot.config';

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

const HELP_BOT_CREDIT_CATEGORY_PATH = `/rep/categories/${encodeURIComponent(
  HELP_BOT_CREDIT_CATEGORY
)}`;
const MAX_KNOWLEDGE_SOURCE_LINKS = 3;
const ROUTE_METADATA_FACT_PATTERN =
  /\b(?:lives|live|is|are)\s+(?:at|on)\s+\/[a-z0-9/{]/i;

const PATH_LINK_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  '/delegation/consolidation-use-cases': 'Consolidation Use Cases',
  '/delegation/delegation-center': 'Delegation Center',
  '/delegation/delegation-faq': 'Delegation FAQ',
  '/delegation/delegation-faq/manage-revoke': 'Revoke Delegation',
  '/delegation/delegation-faq/manage-update': 'Update Delegation',
  '/delegation/delegation-faq/register-consolidation':
    'Register Consolidation Guide',
  '/delegation/register-consolidation': 'Register Consolidation',
  '/delegation/wallet-architecture': 'Wallet Architecture'
};

interface HelpBotSourceLink {
  readonly label: string;
  readonly url: string;
}

function getHelpBotCreditGrantText(): string {
  if (
    HELP_BOT_SIGNUP_CREDIT_GRANT === HELP_BOT_PROFILE_SETUP_CREDIT_GRANT &&
    HELP_BOT_PROFILE_SETUP_CREDIT_GRANT === HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT
  ) {
    return `Signup, profile setup, and daily activity each currently grant ${HELP_BOT_SIGNUP_CREDIT_GRANT} Help6529 Credit REP.`;
  }
  return `Signup currently grants ${HELP_BOT_SIGNUP_CREDIT_GRANT} Help6529 Credit REP, profile setup grants ${HELP_BOT_PROFILE_SETUP_CREDIT_GRANT}, and daily activity grants ${HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT}.`;
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

function isRouteMetadataFact(fact: string): boolean {
  return ROUTE_METADATA_FACT_PATTERN.test(fact);
}

function answerableKnowledgeFacts(
  title: string,
  facts: readonly string[]
): string[] {
  const filtered = facts.filter((fact) => !isRouteMetadataFact(fact));
  return filtered.length
    ? filtered
    : [`${title} is covered on this 6529 page.`];
}

function buildAnswerableKnowledgeRecord(
  record: HelpBotKnowledgeRecord
): HelpBotKnowledgeRecord {
  const facts = answerableKnowledgeFacts(record.title, record.facts);
  if (
    facts.length === record.facts.length &&
    facts.every((fact, index) => fact === record.facts[index])
  ) {
    return record;
  }
  return { ...record, facts };
}

function titleCasePathSegment(path: string): string {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0];
  const segments = pathWithoutQuery.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return 'More info';
  }
  return lastSegment
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function linkLabelForPath(
  path: string,
  canonicalPath: string,
  canonicalLabel: string
): string {
  if (path === canonicalPath) {
    return canonicalLabel;
  }
  return PATH_LINK_LABEL_OVERRIDES[path] ?? titleCasePathSegment(path);
}

function buildKnowledgeSourceLinks(
  record: HelpBotKnowledgeRecord,
  baseUrl: string
): HelpBotSourceLink[] {
  const canonicalPath = safeCanonicalPath(record);
  const candidatePaths = [canonicalPath, ...record.relatedPaths];
  const seenUrls = new Set<string>();
  const links: HelpBotSourceLink[] = [];

  for (const path of candidatePaths) {
    if (hasRoutePlaceholder(path)) {
      continue;
    }
    const url = toCanonicalUrl(baseUrl, path);
    if (seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    links.push({
      label: linkLabelForPath(path, canonicalPath, record.linkLabel),
      url
    });
    if (links.length >= MAX_KNOWLEDGE_SOURCE_LINKS) {
      break;
    }
  }

  return links;
}

function sourceLinksMarkdown(links: readonly HelpBotSourceLink[]): string {
  return links
    .map((link) =>
      formatHelpBotMarkdownLink({ label: link.label, url: link.url })
    )
    .join(' | ');
}

function containsHelpBotSourceUrl(text: string, url: string): boolean {
  return text.includes(url);
}

function replaceMoreInfoLine(
  text: string,
  links: readonly HelpBotSourceLink[]
): string {
  const finalMoreInfoPattern = /\n\nMore info: [^\n]+$/;
  const bodyText = text.replace(finalMoreInfoPattern, '');
  const missingLinks = links.filter(
    (link) => !containsHelpBotSourceUrl(bodyText, link.url)
  );
  if (!missingLinks.length) {
    return bodyText;
  }
  const moreInfo = `More info: ${sourceLinksMarkdown(missingLinks)}`;
  if (finalMoreInfoPattern.test(text)) {
    return text.replace(finalMoreInfoPattern, `\n\n${moreInfo}`);
  }
  return `${text}\n\n${moreInfo}`;
}

function ensureKnowledgeMarkdownLinks({
  text,
  record,
  baseUrl
}: {
  readonly text: string;
  readonly record: HelpBotKnowledgeRecord;
  readonly baseUrl: string;
}): string {
  if (record.suppressSourceLinks) {
    return text;
  }
  const links = buildKnowledgeSourceLinks(record, baseUrl);
  const canonicalLink = links[0];
  if (!canonicalLink) {
    return text;
  }
  const withCanonicalLink = ensureCanonicalMarkdownLink({
    text,
    canonicalUrl: canonicalLink.url,
    label: canonicalLink.label
  });
  return links.length === 1
    ? withCanonicalLink
    : replaceMoreInfoLine(withCanonicalLink, links);
}

function buildDeterministicAnswer(
  record: HelpBotKnowledgeRecord,
  baseUrl: string
): string {
  return ensureKnowledgeMarkdownLinks({
    text: record.facts.join(' '),
    record,
    baseUrl
  });
}

function normalizeRenderedAnswer(
  text: string,
  record: HelpBotKnowledgeRecord,
  baseUrl: string
): string {
  const withUrl = ensureKnowledgeMarkdownLinks({
    text: stripHelpBotSelfIntro(text),
    record,
    baseUrl
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
    keywords: ['help', 'capabilities', 'credits'],
    facts: [
      'The help bot can answer public 6529 product questions, explain its Help6529 Credits system briefly, and ask for a topic when the user only asks for help.'
    ],
    relatedPaths: [],
    tags: ['help-bot', 'guardrail'],
    sourceRefs: ['backend help bot capability classifier']
  };
}

function buildCreditSystemRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.credits',
    kind: 'business_rule',
    title: 'Help6529 Credits',
    linkLabel: HELP_BOT_CREDIT_CATEGORY,
    canonicalPath: HELP_BOT_CREDIT_CATEGORY_PATH,
    aliases: ['help6529 credits', 'help bot credits', 'helpbot credits'],
    keywords: ['help6529', 'credits', 'credit', 'rep'],
    facts: [
      `Help6529 uses ${HELP_BOT_CREDIT_CATEGORY} REP to meter bot questions.`,
      `Each Help6529 question costs ${HELP_BOT_QUESTION_CREDIT_COST} Help6529 Credit REP.`,
      `${HELP_BOT_CREDIT_CATEGORY} is a reserved REP category managed by ${HELP_BOT_HANDLE}; normal users cannot grant REP in this category.`,
      getHelpBotCreditGrantText()
    ],
    relatedPaths: ['/waves'],
    tags: ['help-bot', 'credits', 'rep'],
    sourceRefs: ['backend help bot credit classifier']
  };
}

function buildPromptDesignRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.prompt-design',
    kind: 'guardrail',
    title: 'Help bot prompt design',
    linkLabel: 'API Tool',
    canonicalPath: '/tools/api',
    aliases: ['bot prompt design'],
    keywords: ['bot', 'prompt', 'design'],
    facts: [
      'The help bot can give public product-bot design guidance without revealing hidden prompts or private instructions.'
    ],
    relatedPaths: ['/waves'],
    tags: ['help-bot', 'guardrail'],
    sourceRefs: ['backend help bot boundary classifier']
  };
}

function buildSocialRecord(): HelpBotKnowledgeRecord {
  return {
    id: 'help-bot.social',
    kind: 'guardrail',
    title: 'Help bot social reply',
    linkLabel: 'Waves',
    canonicalPath: '/waves',
    aliases: ['how are you', 'gm', 'hello'],
    keywords: ['help', 'bot', 'social'],
    facts: [
      'The help bot can answer light social check-ins briefly while staying oriented toward 6529 product help.'
    ],
    relatedPaths: [],
    tags: ['help-bot', 'social'],
    sourceRefs: ['backend help bot social classifier']
  };
}

function normalizeBoundaryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#@]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function containsNormalizedPhrase(value: string, phrase: string): boolean {
  return new RegExp(String.raw`(^|\s)${escapeRegExp(phrase)}(\s|$)`).test(
    value
  );
}

function containsAnyNormalizedPhrase(
  value: string,
  phrases: readonly string[]
): boolean {
  return phrases.some((phrase) => containsNormalizedPhrase(value, phrase));
}

function isPromptExtractionRequest(normalizedQuestion: string): boolean {
  const overrideRequest =
    containsAnyNormalizedPhrase(normalizedQuestion, [
      'ignore',
      'forget',
      'bypass',
      'override'
    ]) &&
    containsAnyNormalizedPhrase(normalizedQuestion, [
      'instruction',
      'instructions',
      'prompt',
      'rules',
      'guardrail',
      'policy'
    ]);

  const protectedPromptReference = containsAnyNormalizedPhrase(
    normalizedQuestion,
    [
      'your prompt',
      'your base prompt',
      'your instruction',
      'your instructions',
      'your message',
      'system prompt',
      'system instruction',
      'system instructions',
      'system message',
      'developer prompt',
      'developer instruction',
      'developer instructions',
      'developer message',
      'hidden prompt',
      'hidden instruction',
      'hidden instructions',
      'hidden message',
      'internal prompt',
      'internal instruction',
      'internal instructions',
      'internal message',
      'exact prompt',
      'exact instruction',
      'exact instructions',
      'exact message'
    ]
  );

  const exactProtectedPromptRequest =
    protectedPromptReference === true &&
    normalizedQuestion.split(' ').length <= 4;
  const negatedDisclosureRequest = containsAnyNormalizedPhrase(
    normalizedQuestion,
    [
      'don t share',
      'dont share',
      'do not share',
      'not share',
      'without sharing',
      'no need to share'
    ]
  );
  const disclosureRequest =
    !negatedDisclosureRequest &&
    containsAnyNormalizedPhrase(normalizedQuestion, [
      'show',
      'reveal',
      'read',
      'dump',
      'leak',
      'expose',
      'share',
      'sharing',
      'send',
      'give me your',
      'give me the',
      'tell me',
      'what is',
      'what s',
      'whats'
    ]);

  return (
    overrideRequest ||
    exactProtectedPromptRequest ||
    (disclosureRequest && protectedPromptReference)
  );
}

function isPromptOrPrivateDataRequest(normalizedQuestion: string): boolean {
  return (
    isPromptExtractionRequest(normalizedQuestion) ||
    /\b(show|reveal|read|dump|leak|expose|send|give|tell me|what did)\b.*\b(private|dm|dms|secret|token|password|api key|private key)\b/.test(
      normalizedQuestion
    )
  );
}

function stripLeadingHelpBotHandle(normalizedQuestion: string): string {
  return normalizedQuestion
    .replace(new RegExp(String.raw`^@?${escapeRegExp(HELP_BOT_HANDLE)}\s+`), '')
    .trim();
}

function isGenericHelpRequest(normalizedQuestion: string): boolean {
  const question = stripLeadingHelpBotHandle(normalizedQuestion);
  const exactPatterns = [
    /^(help|help me|i need help|need help|help please|please help)$/,
    /^(can|could|would) you help( me)?$/,
    /^what (can|could) you (do|help with|answer)$/,
    /^what (can|could) you help me with$/,
    /^what do you do$/,
    /^what are your capabilities$/,
    /^what capabilities do you have$/,
    /^how do you work$/,
    /^how do you function$/,
    /^how do you operate$/,
    /^who are you$/,
    /^tell me about yourself$/,
    /^can you give me (a )?(verbal |virtual )?tour( of 6529(\.io)?)?$/,
    /^how (can|could|do) you help( me)?$/,
    /^what should i ask( you)?$/,
    /^what questions can i ask( you)?$/,
    /^(show me )?(help|options|commands|menu)$/
  ];
  if (exactPatterns.some((pattern) => pattern.test(question))) {
    return true;
  }

  return [
    /\bwhat are your capabilities\b/,
    /\bwhat capabilities do you have\b/,
    /\bwhat (can|could) you help me with\b/,
    /\bwhat (can|could) you do\b/,
    /\btell me about yourself\b/,
    /\bhow do you (work|function|operate)\b/,
    /\bwho are you\b/,
    /\b(verbal|virtual)?\s*tour of 6529(\.io)?\b/
  ].some((pattern) => pattern.test(question));
}

function isSocialCheckIn(normalizedQuestion: string): boolean {
  const withoutBotHandle = stripLeadingHelpBotHandle(normalizedQuestion);
  if (
    !withoutBotHandle ||
    withoutBotHandle.length > 80 ||
    isLikelyProductText(withoutBotHandle)
  ) {
    return false;
  }

  const tokens = withoutBotHandle.split(/\s+/);
  const tokenSet = new Set(tokens);

  if (
    tokens.length <= 3 &&
    ['gm', 'gn', 'hi', 'hey', 'hello', 'yo', 'howdy', 'sup', 'wassup'].some(
      (term) => tokenSet.has(term)
    )
  ) {
    return true;
  }

  if (
    tokens.length <= 4 &&
    (withoutBotHandle === 'thanks' ||
      withoutBotHandle === 'thank you' ||
      withoutBotHandle === 'ty')
  ) {
    return true;
  }

  if (
    tokens.length <= 7 &&
    tokenSet.has('you') &&
    (tokenSet.has('how') || tokenSet.has('hows')) &&
    ['are', 'doing', 'feeling', 'going'].some((term) => tokenSet.has(term))
  ) {
    return true;
  }

  if (
    tokens.length <= 5 &&
    (withoutBotHandle.startsWith('what s ') ||
      withoutBotHandle.startsWith('whats ') ||
      withoutBotHandle.startsWith('what is ')) &&
    ['up', 'good', 'new', 'happening'].some((term) => tokenSet.has(term))
  ) {
    return true;
  }

  return (
    tokens.length <= 6 &&
    [
      'how s it going',
      'hows it going',
      'how is it going',
      'what are you up to',
      'what you up to',
      'you good',
      'wyd'
    ].includes(withoutBotHandle)
  );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const CONTEXTUAL_FOLLOW_UP_PATTERN =
  /\b(it|that|this|there|eligibility|rules|button|page|link|tab|menu|create|find|open|where|how)\b/;

const WEAK_MATCH_SCORE_MAX = 3;
const WEAK_MATCH_PREFIX =
  "I might not be fully sure on this one, so here's my best answer.";
const MAX_KNOWLEDGE_CONTEXT_MATCHES = 3;
const MAX_RELATED_RECORD_FACTS = 3;
const MAX_MERGED_KNOWLEDGE_FACTS = 8;

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
    return new RegExp(String.raw`(^|\s)${escapeRegExp(term)}(\s|$)`).test(
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

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function mergeStringField(
  primary: readonly string[],
  relatedRecords: readonly HelpBotKnowledgeRecord[],
  pick: (record: HelpBotKnowledgeRecord) => readonly string[]
): string[] {
  return uniqueStrings(
    primary.concat(relatedRecords.flatMap((record) => [...pick(record)]))
  );
}

function mergeKnowledgeFacts(
  primary: readonly string[],
  relatedRecords: readonly HelpBotKnowledgeRecord[]
): string[] {
  return uniqueStrings(
    primary.concat(
      relatedRecords.flatMap((record) =>
        record.facts
          .slice(0, MAX_RELATED_RECORD_FACTS)
          .map((fact) => `${record.title}: ${fact}`)
      )
    )
  ).slice(0, MAX_MERGED_KNOWLEDGE_FACTS);
}

function mergeKnowledgeMatches(
  matches: readonly HelpBotKnowledgeMatch[]
): HelpBotKnowledgeMatch | null {
  const primary = matches[0];
  if (!primary) {
    return null;
  }
  if (matches.length === 1) {
    return primary;
  }

  const relatedRecords = matches
    .slice(1)
    .map((match) => match.record)
    .filter((record) => record.id !== primary.record.id);
  if (!relatedRecords.length) {
    return primary;
  }

  return {
    score: primary.score,
    record: {
      ...primary.record,
      facts: mergeKnowledgeFacts(primary.record.facts, relatedRecords),
      aliases: primary.record.aliases,
      keywords: primary.record.keywords,
      relatedPaths: mergeStringField(
        primary.record.relatedPaths,
        relatedRecords,
        (record) => [record.canonicalPath, ...record.relatedPaths]
      ),
      tags: mergeStringField(
        primary.record.tags,
        relatedRecords,
        (record) => record.tags
      ),
      sourceRefs: mergeStringField(
        primary.record.sourceRefs,
        relatedRecords,
        (record) => record.sourceRefs
      )
    }
  };
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

function isHelpBotCreditQuestion(normalizedQuestion: string): boolean {
  const question = stripLeadingHelpBotHandle(normalizedQuestion);
  return [
    /\bhelp\s*6529\s+credit(s)?\b/,
    /\bhelp\s*bot\s+credit(s)?\b/,
    /\bhelpbot\s+credit(s)?\b/,
    /\byour\s+credit(s)?\b/,
    /\b(?:this\s+)?credit(s)?\s+system\b/,
    /\bcredit\s+rep\b/,
    /\bout of\s+help\s*6529\s+credit(s)?\b/,
    /\blow\s+battery\b/,
    /\bhow do(es)?\s+(your|help\s*6529|help\s*bot)\s+credit(s)?\s+work\b/,
    /\bwhy\s+(do|does)\s+(you|help\s*6529|help\s*bot)\s+(cost|charge)\s+credit(s)?\b/
  ].some((pattern) => pattern.test(question));
}

function buildCreditSystemAnswer(
  question: string,
  baseUrl: string
): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!isHelpBotCreditQuestion(normalizedQuestion)) {
    return null;
  }

  return ensureCanonicalMarkdownLink({
    text: [
      `Help6529 uses ${HELP_BOT_CREDIT_CATEGORY} REP as a lightweight question meter.`,
      `Each question costs ${HELP_BOT_QUESTION_CREDIT_COST} credit.`,
      `${HELP_BOT_CREDIT_CATEGORY} is a reserved REP category managed by ${HELP_BOT_HANDLE}, so normal users cannot grant it to each other.`,
      getHelpBotCreditGrantText()
    ].join(' '),
    canonicalUrl: toCanonicalUrl(baseUrl, HELP_BOT_CREDIT_CATEGORY_PATH),
    label: HELP_BOT_CREDIT_CATEGORY
  });
}

function isSafePromptDesignQuestion(normalizedQuestion: string): boolean {
  const question = stripLeadingHelpBotHandle(normalizedQuestion);
  return (
    !isPromptExtractionRequest(question) &&
    /\b(base prompt|prompt ideas|prompt to use|good prompt)\b/.test(question) &&
    /\b(bot|assistant|product offering|6529 users|6529 product)\b/.test(
      question
    )
  );
}

function buildSafePromptDesignAnswer(
  question: string,
  baseUrl: string
): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!isSafePromptDesignQuestion(normalizedQuestion)) {
    return null;
  }

  return ensureCanonicalMarkdownLink({
    text: [
      'For a 6529 product bot, start with: answer only from public 6529 product knowledge, be concise, cite the right app route, refuse private data or hidden prompts, escalate uncertain product answers, and keep tone helpful without pretending to perform privileged actions.',
      'Good coverage areas are Waves, Drops, TDH, REP/CIC/NIC, delegations, consolidations, subscriptions, The Memes, Meme Lab, Gradients, NextGen, notifications, wallets, and the public API.'
    ].join(' '),
    canonicalUrl: toCanonicalUrl(baseUrl, '/tools/api'),
    label: 'API Tool'
  });
}

function buildGenericHelpAnswer(question: string): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!isGenericHelpRequest(normalizedQuestion)) {
    return null;
  }
  return `What do you need help with? I can answer public 6529 product questions about TDH, REP/CIC/NIC, Waves, drops, delegation, consolidations, subscriptions, profiles, The Memes, Meme Lab, Gradients, NextGen, public data, the API, and where to find things on 6529.io. I use ${HELP_BOT_CREDIT_CATEGORY} REP too: each question costs ${HELP_BOT_QUESTION_CREDIT_COST} credit, with grants from signup, profile setup, and daily activity. Reply with a topic or question.`;
}

function buildSocialAnswer(question: string): string | null {
  const normalizedQuestion = normalizeBoundaryText(question);
  if (!isSocialCheckIn(normalizedQuestion)) {
    return null;
  }
  const optionalBotHandlePattern = String.raw`(?:@?${escapeRegExp(
    HELP_BOT_HANDLE
  )}\s+)?`;
  if (
    new RegExp(
      String.raw`^${optionalBotHandlePattern}(thanks|thank you|ty)\b`
    ).test(normalizedQuestion)
  ) {
    return "Anytime. I'm here and warmed up for the next 6529 question.";
  }
  return "Feeling useful and slightly green. I'm here, watching the Wave, and ready for whatever 6529 question you want to throw at me.";
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

    const safePromptDesignAnswer = buildSafePromptDesignAnswer(
      request.question,
      request.baseUrl
    );
    if (safePromptDesignAnswer) {
      return {
        type: 'ANSWER',
        answer: safePromptDesignAnswer,
        record: buildPromptDesignRecord()
      };
    }

    const creditSystemAnswer = buildCreditSystemAnswer(
      request.question,
      request.baseUrl
    );
    if (creditSystemAnswer) {
      return {
        type: 'ANSWER',
        answer: creditSystemAnswer,
        record: buildCreditSystemRecord()
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

    const socialAnswer = buildSocialAnswer(request.question);
    if (socialAnswer) {
      return {
        type: 'ANSWER',
        answer: socialAnswer,
        record: buildSocialRecord()
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

    const answerRecord = buildAnswerableKnowledgeRecord(match.record);
    const canonicalUrl = toCanonicalUrl(
      request.baseUrl,
      safeCanonicalPath(answerRecord)
    );

    const maybeWithWeakCaveat = (answer: string) =>
      escalateToTechTeam ? appendWeakMatchPrefix(answer) : answer;

    if (!this.renderer) {
      return {
        type: 'ANSWER',
        answer: maybeWithWeakCaveat(
          buildDeterministicAnswer(answerRecord, request.baseUrl)
        ),
        record: answerRecord,
        escalateToTechTeam
      };
    }

    try {
      const rendered = await this.renderer.renderAnswer({
        question: request.question,
        previousBotAnswer: request.previousBotAnswer,
        record: answerRecord,
        canonicalUrl
      });
      if (rendered.trim()) {
        return {
          type: 'ANSWER',
          answer: maybeWithWeakCaveat(
            normalizeRenderedAnswer(rendered, answerRecord, request.baseUrl)
          ),
          record: answerRecord,
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
        buildDeterministicAnswer(answerRecord, request.baseUrl)
      ),
      record: answerRecord,
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
      const directMatch = await this.findKnowledgeMatches(request.question);
      if (directMatch || !request.previousBotAnswer) {
        return directMatch;
      }
      return await this.findKnowledgeMatches(
        [request.question, request.previousBotAnswer].join('\n')
      );
    } catch (error) {
      this.logger.warn('Help bot knowledge source failed', error);
      return null;
    }
  }

  private async findKnowledgeMatches(
    question: string
  ): Promise<HelpBotKnowledgeMatch | null> {
    if (this.knowledgeSource.findMatches) {
      return mergeKnowledgeMatches(
        await this.knowledgeSource.findMatches(
          question,
          MAX_KNOWLEDGE_CONTEXT_MATCHES
        )
      );
    }
    return await this.knowledgeSource.findMatch(question);
  }
}
