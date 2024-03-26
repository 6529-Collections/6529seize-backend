import OpenAI from 'openai';
import { AiPrompter } from './ai-prompter';
import { getOpenAiInstance } from '../openai';

class OpenAiPrompter implements AiPrompter {
  constructor(private readonly getOpenAi: () => OpenAI) {}

  public async promptAndGetReply(prompt: string): Promise<string> {
    const openAiResponse = await this.getOpenAi().chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    });
    return openAiResponse.choices[0].message.content ?? '';
  }
}

export const openAiPrompter = new OpenAiPrompter(getOpenAiInstance);
