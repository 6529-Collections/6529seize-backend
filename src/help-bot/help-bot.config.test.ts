import {
  HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY,
  HELP_BOT_TECH_TEAM_HANDLES_ENV,
  buildHelpBotNoReliableSourceReply,
  getHelpBotTechTeamMentionHandles
} from './help-bot.config';

describe('help bot config', () => {
  const previousTechTeamHandles = process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];

  afterEach(() => {
    if (previousTechTeamHandles === undefined) {
      delete process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];
      return;
    }
    process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV] = previousTechTeamHandles;
  });

  it('omits tech team mentions when the env var is missing', () => {
    delete process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];

    expect(getHelpBotTechTeamMentionHandles()).toEqual([]);
    expect(buildHelpBotNoReliableSourceReply()).toBe(
      HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY
    );
  });

  it('normalizes, filters, and dedupes tech team handles', () => {
    process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV] =
      ' @Alice ;bob;alice;bad handle;@carol ';

    expect(getHelpBotTechTeamMentionHandles()).toEqual([
      'Alice',
      'bob',
      'carol'
    ]);
    expect(buildHelpBotNoReliableSourceReply()).toBe(
      `${HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY} @Alice @bob @carol`
    );
  });
});
