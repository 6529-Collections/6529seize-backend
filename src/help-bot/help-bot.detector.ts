import { ApiCreateDropRequest } from '@/api/generated/models/ApiCreateDropRequest';
import { ApiDrop } from '@/api/generated/models/ApiDrop';
import { HELP_BOT_HANDLE } from './help-bot.config';
import { HelpBotInteractionTriggerType } from '@/entities/IHelpBotInteraction';

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
  'nice',
  'gm'
]);

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
  return normalized.length > 2 && !ACKNOWLEDGEMENTS.has(normalized);
}

function isContextDependentQuestion(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return [
    /^(is|was|are|were) (this|that|it|these|those) (right|correct|true|accurate)$/,
    /^(is|was|are|were) (this|that|it|these|those) (wrong|incorrect|false)$/,
    /^(does|did) (this|that|it) (look|sound|seem) (right|correct|true|accurate)$/,
    /^can you (check|confirm|verify) (this|that|it)$/,
    /^is this$/,
    /^is that$/
  ].some((pattern) => pattern.test(normalized));
}

function buildQuestionWithParentContext(
  question: string,
  parentQuestion: string
): string {
  return `${question}\n\nContext from the replied-to drop: ${parentQuestion}`;
}

export function detectHelpBotTrigger(
  input: HelpBotTriggerDetectionInput
): HelpBotTriggerDetection | null {
  if (input.authorProfileId === input.botProfileId) {
    return null;
  }

  const text = extractText(input.request);
  const question = stripBotMention(text);

  if (hasExplicitMention(input, text)) {
    const parentDrop = input.parentDrop;
    const parentQuestion = stripBotMention(extractDropText(parentDrop));
    if (
      isMeaningfulQuestion(question) &&
      isContextDependentQuestion(question) &&
      parentDrop &&
      parentDrop.author.id !== input.botProfileId &&
      isMeaningfulQuestion(parentQuestion)
    ) {
      return {
        triggerDropId: input.createdDrop.id,
        targetDropId: input.createdDrop.id,
        waveId: input.createdDrop.wave.id,
        authorProfileId: input.authorProfileId,
        question: buildQuestionWithParentContext(question, parentQuestion),
        triggerType: HelpBotInteractionTriggerType.MENTION,
        parentBotDropId: null
      };
    }

    if (isMeaningfulQuestion(question)) {
      return {
        triggerDropId: input.createdDrop.id,
        targetDropId: input.createdDrop.id,
        waveId: input.createdDrop.wave.id,
        authorProfileId: input.authorProfileId,
        question,
        triggerType: HelpBotInteractionTriggerType.MENTION,
        parentBotDropId: null
      };
    }

    if (
      parentDrop &&
      parentDrop.author.id !== input.botProfileId &&
      isMeaningfulQuestion(parentQuestion)
    ) {
      return {
        triggerDropId: input.createdDrop.id,
        targetDropId: parentDrop.id,
        waveId: input.createdDrop.wave.id,
        authorProfileId: input.authorProfileId,
        question: parentQuestion,
        triggerType: HelpBotInteractionTriggerType.MENTION,
        parentBotDropId: null
      };
    }

    return null;
  }

  if (!isMeaningfulQuestion(question)) {
    return null;
  }

  const parentBotDropId =
    input.parentDrop?.author.id === input.botProfileId
      ? input.parentDrop.id
      : null;

  if (parentBotDropId) {
    return {
      triggerDropId: input.createdDrop.id,
      targetDropId: input.createdDrop.id,
      waveId: input.createdDrop.wave.id,
      authorProfileId: input.authorProfileId,
      question,
      triggerType: HelpBotInteractionTriggerType.BOT_REPLY,
      parentBotDropId
    };
  }

  return null;
}
