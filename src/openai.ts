import OpenAI from 'openai';

let openAi: OpenAI | null = null;

export function getOpenAiInstance(): OpenAI {
  if (!openAi) {
    openAi = new OpenAI({
      apiKey: process.env.OPEN_AI_API_KEY
    });
  }
  return openAi;
}
