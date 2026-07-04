import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { HELP_BOT_HANDLE } from './help-bot.config';
import { HelpBotInteractionTriggerType } from '@/entities/IHelpBotInteraction';
import {
  HELP_BOT_REPLIED_DROP_CONTEXT_PREFIX,
  isHelpBotContextVerificationQuestion
} from './help-bot-question-context';

export interface HelpBotTriggerDetectionInput {
  readonly request: ApiCreateDropRequest;
  readonly createdDrop: ApiDrop;
  readonly authorProfileId: string;
  readonly botProfileId: string;
  readonly parentDrop?: ApiDrop | null;
}

export interface HelpBotTriggerDetection {
  readonly triggerDropId: string;
  readonly targetDropId: string;
  readonly waveId: string;
  readonly authorProfileId: string;
  readonly question: string;
  readonly triggerType: HelpBotInteractionTriggerType;
  readonly parentBotDropId: string | null;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const ESCAPED_HELP_BOT_HANDLE = escapeRegExp(HELP_BOT_HANDLE);
const HANDLE_MENTION_REGEX = new RegExp(
  String.raw`(^|[^a-z0-9_])@(?:${ESCAPED_HELP_BOT_HANDLE}\b|\[${ESCAPED_HELP_BOT_HANDLE}\])`,
  'i'
);
const HANDLE_MENTION_REPLACE_REGEX = new RegExp(
  String.raw`(^|[^a-z0-9_])@(?:${ESCAPED_HELP_BOT_HANDLE}\b|\[${ESCAPED_HELP_BOT_HANDLE}\])`,
  'gi'
);

const ACKNOWLEDGEMENTS = new Set([
  'thanks',
  'thank you',
  'ty',
  'ok',
  'okay',
  'got it',
  'great',
  'cool',
  'nice'
]);

const SHORT_SOCIAL_QUERIES = new Set(['gm', 'gn', 'hi', 'yo']);

function normalizeHandle(handle: string | null | undefined): string {
  return handle?.replace(/^@/, '').trim().toLowerCase() ?? '';
}

function extractText(request: ApiCreateDropRequest): string {
  return request.parts
    .map((part) => part.content ?? '')
    .join('\n')
    .trim();
}

function extractDropText(drop: ApiDrop | null | undefined): string {
  return (
    drop?.parts
      .map((part) => part.content ?? '')
      .join('\n')
      .trim() ?? ''
  );
}

function stripBotMention(text: string): string {
  return text
    .replace(HANDLE_MENTION_REPLACE_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMentionedBot(
  mentions:
    | readonly {
        readonly handle_in_content?: string | null;
        readonly current_handle?: string | null;
      }[]
    | null
    | undefined
): boolean {
  return (mentions ?? []).some((user) => {
    return (
      normalizeHandle(user.handle_in_content) === HELP_BOT_HANDLE ||
      normalizeHandle(user.current_handle) === HELP_BOT_HANDLE
    );
  });
}

function hasExplicitMention(input: HelpBotTriggerDetectionInput, text: string) {
  return (
    hasMentionedBot(input.request.mentioned_users) ||
    hasMentionedBot(input.createdDrop.mentioned_users) ||
    HANDLE_MENTION_REGEX.test(text)
  );
}

function isMeaningfulQuestion(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return (
    (normalized.length > 2 || SHORT_SOCIAL_QUERIES.has(normalized)) &&
    !ACKNOWLEDGEMENTS.has(normalized)
  );
}

function isContextDependentQuestion(text: string): boolean {
  return isHelpBotContextVerificationQuestion(text);
}

function buildQuestionWithParentContext(
  question: string,
  parentQuestion: string
): string {
  return `${question}\n\n${HELP_BOT_REPLIED_DROP_CONTEXT_PREFIX} ${parentQuestion}`;
}

function getParentBotDropId(
  input: HelpBotTriggerDetectionInput
): string | null {
  return input.parentDrop?.author.id === input.botProfileId
    ? input.parentDrop.id
    : null;
}

function createDetection(
  input: HelpBotTriggerDetectionInput,
  {
    question,
    triggerType,
    parentBotDropId,
    targetDropId = input.createdDrop.id
  }: {
    readonly question: string;
    readonly triggerType: HelpBotInteractionTriggerType;
    readonly parentBotDropId: string | null;
    readonly targetDropId?: string;
  }
): HelpBotTriggerDetection {
  return {
    triggerDropId: input.createdDrop.id,
    targetDropId,
    waveId: input.createdDrop.wave.id,
    authorProfileId: input.authorProfileId,
    question,
    triggerType,
    parentBotDropId
  };
}

function canUseParentQuestion(
  input: HelpBotTriggerDetectionInput,
  parentQuestion: string
): input is HelpBotTriggerDetectionInput & { parentDrop: ApiDrop } {
  return (
    !!input.parentDrop &&
    input.parentDrop.author.id !== input.botProfileId &&
    isMeaningfulQuestion(parentQuestion)
  );
}

function detectExplicitMentionTrigger({
  input,
  question,
  parentBotDropId
}: {
  readonly input: HelpBotTriggerDetectionInput;
  readonly question: string;
  readonly parentBotDropId: string | null;
}): HelpBotTriggerDetection | null {
  const parentQuestion = stripBotMention(extractDropText(input.parentDrop));
  if (
    isMeaningfulQuestion(question) &&
    isContextDependentQuestion(question) &&
    canUseParentQuestion(input, parentQuestion)
  ) {
    return createDetection(input, {
      question: buildQuestionWithParentContext(question, parentQuestion),
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  }

  if (isMeaningfulQuestion(question)) {
    return createDetection(input, {
      question,
      triggerType: parentBotDropId
        ? HelpBotInteractionTriggerType.BOT_REPLY
        : HelpBotInteractionTriggerType.MENTION,
      parentBotDropId
    });
  }

  if (canUseParentQuestion(input, parentQuestion)) {
    return createDetection(input, {
      targetDropId: input.parentDrop.id,
      question: parentQuestion,
      triggerType: HelpBotInteractionTriggerType.MENTION,
      parentBotDropId: null
    });
  }

  return null;
}

export function detectHelpBotTrigger(
  input: HelpBotTriggerDetectionInput
): HelpBotTriggerDetection | null {
  if (input.authorProfileId === input.botProfileId) {
    return null;
  }

  const text = extractText(input.request);
  const question = stripBotMention(text);
  const parentBotDropId = getParentBotDropId(input);

  if (hasExplicitMention(input, text)) {
    return detectExplicitMentionTrigger({ input, question, parentBotDropId });
  }

  if (!isMeaningfulQuestion(question)) {
    return null;
  }

  if (parentBotDropId) {
    return createDetection(input, {
      question,
      triggerType: HelpBotInteractionTriggerType.BOT_REPLY,
      parentBotDropId
    });
  }

  return null;
}
