import { AbusivenessCheckService } from './abusiveness-check.service';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { AiBasedAbusivenessDetector } from '../abusiveness/ai-based-abusiveness.detector';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { Time } from '../time';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import { Discord, DiscordChannel } from '../discord';

const anAbusivenessCheckResult: AbusivenessDetectionResult = {
  text: 'text',
  status: 'ALLOWED',
  explanation: null,
  external_check_performed_at: Time.millis(0).toDate()
};

describe(`AbusivenessCheckService`, () => {
  let abusivenessCheckService: AbusivenessCheckService;
  let abusivenessCheckDb: AbusivenessCheckDb;
  let abusivenessDetector: AiBasedAbusivenessDetector;
  let discord: Discord;

  beforeEach(() => {
    abusivenessCheckDb = mock();
    abusivenessDetector = mock();
    discord = mock();
    abusivenessCheckService = new AbusivenessCheckService(
      abusivenessDetector,
      abusivenessCheckDb,
      discord
    );
  });

  it(`should throw BadRequestException if text is empty`, async () => {
    await expect(abusivenessCheckService.checkRepPhrase('  ')).rejects.toThrow(
      `Category can't be empty.`
    );
  });

  it(`should throw BadRequestException if text is longer than 100 characters`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('r'.repeat(101))
    ).rejects.toThrow('Category is 101 characters long - the maximum is 100.');
  });

  it(`should throw BadRequestException if text starts with a dash`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('-Unreliable')
    ).rejects.toThrow(`Category can't start with a dash.`);
  });

  it(`should accept a non-leading dash`, async () => {
    const input = 'state-of-the-art';
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkRepPhrase(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
  });

  it(`should return result from DB if it has result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkRepPhrase(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
    expect(abusivenessDetector.checkRepPhraseText).not.toHaveBeenCalledWith(
      input
    );
  });

  it(`should accept unicode letters and numbers`, async () => {
    const input = '建設者 реп 123';
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkRepPhrase(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
  });

  it(`should turn to AI, save the result and finally return it if database has no result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(null);
    when(abusivenessDetector.checkRepPhraseText)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkRepPhrase(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
    expect(abusivenessCheckDb.saveResult).toHaveBeenCalledWith(
      anAbusivenessCheckResult
    );
  });

  it(`should throw BadRequestException if text contains newlines`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('Hey\nyou')
    ).rejects.toThrow(
      `Category contains disallowed characters: line break. Allowed characters are letters, numbers, spaces, dashes and , . ? ! ' ( ).`
    );
  });

  it(`should throw BadRequestException if text contains tabs`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('Hey\tyou')
    ).rejects.toThrow(
      `Category contains disallowed characters: tab. Allowed characters are letters, numbers, spaces, dashes and , . ? ! ' ( ).`
    );
  });

  it(`should throw BadRequestException if text contains special characters`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('Hey%you')
    ).rejects.toThrow(
      `Category contains disallowed characters: "%". Allowed characters are letters, numbers, spaces, dashes and , . ? ! ' ( ).`
    );
  });

  it(`should allow if AI check for REP fails with unknown error, but should send a notification to Discord`, async () => {
    when(abusivenessDetector.checkRepPhraseText).mockRejectedValue(
      `Some error`
    );
    await expect(
      abusivenessCheckService.checkRepPhrase('Hello')
    ).resolves.toEqual({
      text: 'Hello',
      status: 'ALLOWED',
      explanation: null,
      external_check_performed_at: expect.any(Date)
    });
    expect(discord.sendMessage).toHaveBeenCalledWith(
      DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
      `Rep phrase: Hello\n\nAI abusiveness check failed with error: Some error`
    );
  });
});
