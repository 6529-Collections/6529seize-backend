import { AbusivenessCheckService } from './abusiveness-check.service';
import { AbusivenessCheckDb } from './abusiveness-check.db';
import { OpenAiAbusivenessDetectionService } from '../open-ai-abusiveness-detection.service';
import { mock } from 'ts-jest-mocker';
import { when } from 'jest-when';
import { Time } from '../time';
import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';

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

  beforeEach(() => {
    abusivenessCheckDb = mock();
    openAiAbusivenessDetectionService = mock();
    abusivenessCheckService = new AbusivenessCheckService(
      openAiAbusivenessDetectionService,
      abusivenessCheckDb
    );
  });

  it(`should throw BadRequestException if text is empty`, async () => {
    await expect(
      abusivenessCheckService.checkAbusiveness('  ')
    ).rejects.toThrow('Text must be 1-100 characters');
  });

  it(`should throw BadRequestException if text is longer than 100 characters`, async () => {
    await expect(
      abusivenessCheckService.checkAbusiveness('r'.repeat(101))
    ).rejects.toThrow('Text must be 1-100 characters');
  });

  it(`should return result from DB if it has result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkAbusiveness(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
    expect(
      openAiAbusivenessDetectionService.checkText
    ).not.toHaveBeenCalledWith(input);
  });

  it(`should turn to OpenAI, save the result and finally return it if database has no result`, async () => {
    const input = "Gr3at 'react' (or, something)! dev?";
    when(abusivenessCheckDb.findResult)
      .calledWith(input)
      .mockResolvedValue(null);
    when(openAiAbusivenessDetectionService.checkText)
      .calledWith(input)
      .mockResolvedValue(anAbusivenessCheckResult);
    await expect(
      abusivenessCheckService.checkAbusiveness(input)
    ).resolves.toEqual(anAbusivenessCheckResult);
    expect(abusivenessCheckDb.saveResult).toHaveBeenCalledWith(
      anAbusivenessCheckResult
    );
  });

  it(`should throw BadRequestException if text contains newlines`, async () => {
    await expect(
      abusivenessCheckService.checkAbusiveness('Hey\nyou')
    ).rejects.toThrow(
      'Text for abusiveness check contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });

  it(`should throw BadRequestException if text contains tabs`, async () => {
    await expect(
      abusivenessCheckService.checkAbusiveness('Hey\tyou')
    ).rejects.toThrow(
      'Text for abusiveness check contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });

  it(`should throw BadRequestException if text special characters`, async () => {
    await expect(
      abusivenessCheckService.checkAbusiveness('Hey%you')
    ).rejects.toThrow(
      'Text for abusiveness check contains invalid characters, is shorter than one character or is longer than 100 characters. Only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes are allowed.'
    );
  });
});
