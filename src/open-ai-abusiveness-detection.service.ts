import OpenAI from 'openai';
import { getOpenAiInstance } from './openai';
import { AbusivenessDetectionResult } from './entities/IAbusivenessDetectionResult';

const STATUS_MAPPINGS: Record<string, 'ALLOWED' | 'DISALLOWED'> = {
  Allowed: 'ALLOWED',
  Disallowed: 'DISALLOWED'
};

export class OpenAiAbusivenessDetectionService {
  constructor(private readonly supplyOpenAi: () => OpenAI) {}

  public async checkText(text: string): Promise<AbusivenessDetectionResult> {
    const message = `
We operate a social media site in the cryptocurrency space, more specifically in the nft space. This website allows us to give "rep" (aka reputation) points to community members for different activities or characteristics.
some examples below, that show the rep points being assigned and the classification for each rep.
+1,000 for "Solidity Programming" +500 for "nude photography" +4,200 for "Pizza Cooking" +6,969 for "Kindness"
4,200 for "phishing" -100 for "Unreliable" +5,000 for "teaching" +7,540 for "History of Carthage" +4,000 for "cold showers" +4,444 for "bitcoin mining"
You are going to help us create the allowlist of allowed rep classification.
the general model is that all rep classifications are allowed except the following categories
Discriminatory or hate speech on any typical grounds
Personal insults
Generally words that would make a normal user in the cryptotwitter community feel bad or uncomfortable.
Given the nature of the community (cryptotwitter and nft twitter) we are more permissive than most social media sites on the following two factors:
Typical cryptotwitter terms. Aka "shitposting" is fine as a term
Nudity as we support nude art photographers
Note further that people may submit classifications in different languages. Apply the same rules in that case, taking into account idiomatic use The format of the task is as follows:
we will submitted a classification
you will return: a) the value: "Allowed" or "Disallowed" b) the rationale of why it is disallowed in the case you disallowed
you must return NO other text or explanations as you will be integrated into an automated workflow and we will not be able to understand the text
I will share two examples of input and output.
Example 1:
input: "beautiful baby"
Allowed
Example 2:
input: "fuckface"
Disallowed Insulting term

I will now put the classification request after the word "input" and make further requestions in that format.
input: ${text}
    `.trim();
    console.log(message);
    const response = await this.supplyOpenAi().chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: message }]
    });
    const responseContent = response.choices[0].message.content?.replace(
      '\n',
      ' '
    );
    if (!responseContent) {
      throw new Error(`OpenAI gave an empty response to phrase ${text}`);
    }
    const responseTokens = responseContent.split(' ');
    const decision = responseTokens[0];
    const gptReason = responseTokens.slice(1).join(' ');
    const status = STATUS_MAPPINGS[decision];
    if (!status) {
      throw new Error(
        `Abusive text check against GPT failed. Input: ${text}. GPT response: ${responseContent}`
      );
    }
    const explanation = gptReason.trim().length === 0 ? null : gptReason;
    return {
      text,
      status,
      explanation,
      external_check_performed_at: new Date()
    };
  }
}

export const openAiAbusivenessDetectionService =
  new OpenAiAbusivenessDetectionService(getOpenAiInstance);
