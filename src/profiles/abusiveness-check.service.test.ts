import { AbusivenessCheckService } from './abusiveness-check.service';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { OpenAiAbusivenessDetectionService } from '../open-ai-abusiveness-detection.service';
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
  let openAiAbusivenessDetectionService: OpenAiAbusivenessDetectionService;
  let discord: Discord;

  beforeEach(() => {
    abusivenessCheckDb = mock();
    openAiAbusivenessDetectionService = mock();
    discord = mock();
    abusivenessCheckService = new AbusivenessCheckService(
      openAiAbusivenessDetectionService,
      abusivenessCheckDb,
      discord
    );
  });

  it(`should throw BadRequestException if text is empty`, async () => {
    await expect(abusivenessCheckService.checkRepPhrase('  ')).rejects.toThrow(
      'Text must be 1-100 characters'
    );
  });

  it(`should throw BadRequestException if text is longer than 100 characters`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('r'.repeat(101))
    ).rejects.toThrow('Text must be 1-100 characters');
  });

  it(`should return result from DB if it has result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkRepPhrase(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
    expect(
      openAiAbusivenessDetectionService.checkRepPhraseText
    ).not.toHaveBeenCalledWith(input);
  });

  it(`should turn to OpenAI, save the result and finally return it if database has no result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(null);
    when(openAiAbusivenessDetectionService.checkRepPhraseText)
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
      'Rep statement contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });

  it(`should throw BadRequestException if text contains tabs`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('Hey\tyou')
    ).rejects.toThrow(
      'Rep statement contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });

  it(`should throw BadRequestException if text contains special characters`, async () => {
    await expect(
      abusivenessCheckService.checkRepPhrase('Hey%you')
    ).rejects.toThrow(
      'Rep statement contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });

  it(`should allow if OpenAI check for REP fails with unknown error, but should send a notification to Discord`, async () => {
    when(
      openAiAbusivenessDetectionService.checkRepPhraseText
    ).mockRejectedValue(`Some error`);
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
      `Rep phrase: Hello\n\nOpenAI check failed with error: Some error`
    );
  });
});
