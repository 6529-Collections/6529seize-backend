import type {
  HelpBotAnswerRequest,
  HelpBotAnswerResult
} from './help-bot.answerer';
import type { HelpBotKnowledgeSource } from './help-bot.knowledge';
import { composeDesktopAnswer } from './help-bot-desktop-answer';
import { parseHelpBotQuestionContext } from './help-bot-question-context';

// Restrict this shortcut to availability/download vocabulary. A mention of "app"
// must not swallow wallet procedures, troubleshooting, or other companies' apps.
const DISCOVERY_WORDS = new Set(
  (
    '6529 app apps application applications is are there theres a an any the ' +
    'do does you u we have has got offer offers official native mobile desktop ' +
    'phone phones computer computers iphone ipad android ios windows mac macos linux ' +
    'for on get download downloads install installation link links where how can i ' +
    'find it available availability please pls hey hi yes ok okay and or about ' +
    'this that site website my your our me only'
  ).split(' ')
);

function isAppDiscoveryQuestion(
  question: string,
  previousAnswer: string
): boolean {
  const normalized = question
    .toLowerCase()
    .replace(/6529\.io/g, '6529')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = normalized.split(' ');
  if (!normalized || !words.every((word) => DISCOVERY_WORDS.has(word)))
    return false;
  if (words.some((word) => /^(?:apps?|applications?)$/.test(word))) return true;
  const followsAppDownloads =
    /\b6529 Mobile\b/i.test(previousAnswer) &&
    /\b6529 Desktop\b/i.test(previousAnswer) &&
    /\bdownloads?\b/i.test(previousAnswer);
  return (
    (words.includes('6529') || followsAppDownloads) &&
    words.some((word) =>
      /^(?:download|downloads|install|link|links|where|how|mobile|desktop|android|ios|iphone|ipad|windows|mac|macos|linux)$/.test(
        word
      )
    )
  );
}

/** Generic questions to help6529 refer to its apps; the corpus owns product facts. */
export async function answerAppDiscovery(
  request: HelpBotAnswerRequest,
  knowledge: HelpBotKnowledgeSource
): Promise<HelpBotAnswerResult | null> {
  const context = parseHelpBotQuestionContext(request.question);
  if (
    !isAppDiscoveryQuestion(
      context.primaryQuestion,
      request.previousBotAnswer ?? context.repliedToDropContext ?? ''
    )
  )
    return null;
  const match = await knowledge.findMatch('6529 apps', { desktopScope: false });
  if (
    match?.record.id !== 'about.6529-apps' ||
    !match.record.briefAnswer ||
    !match.record.answerLinks?.length
  ) {
    return { type: 'NO_RELIABLE_SOURCE', escalateToTechTeam: true };
  }
  const answer = composeDesktopAnswer(
    match.record.briefAnswer,
    match.record,
    'corpus'
  );
  if (!answer || answer.length > 1200) {
    return { type: 'NO_RELIABLE_SOURCE', escalateToTechTeam: true };
  }
  return { type: 'ANSWER', answer, record: match.record };
}
