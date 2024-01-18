import OpenAI from 'openai';
import { getOpenAiInstance } from './openai';
import { AbusivenessDetectionResult } from './entities/IAbusivenessDetectionResult';

const STATUS_MAPPINGS: Record<string, 'ALLOWED' | 'DISALLOWED'> = {
  Allowed: 'ALLOWED',
  Disallowed: 'DISALLOWED'
};

export class OpenAiAbusivenessDetectionService {
  constructor(private readonly supplyOpenAi: () => OpenAI) {}

  public async checkRepPhraseText(text: string): Promise<AbusivenessDetectionResult> {
    const message = `
Background

We operate a social media site in the cryptocurrency space, more specifically in the nft space. This website allows us to give "rep" (aka reputation) points to community members for different activities or characteristics.
some examples below, that show the rep points being assigned and the classification for each rep.
+1,000 for "Solidity Programming" +500 for "nude photography" +4,200 for "Pizza Cooking" +6,969 for "Kindness"
4,200 for "phishing" -100 for "Unreliable" +5,000 for "teaching" +7,540 for "History of Carthage" +4,000 for "cold showers" +4,444 for "bitcoin mining"
Task

You are going to help us create the allowlist of allowed rep classifications
The general model is that all rep classifications are allowed except the following five categories
1. Discriminatory or hate speech on any typical grounds
2. Personal insults
3. Generally words that would make a normal user in the cryptotwitter community feel bad or uncomfortable. Given the nature of the community (cryptotwitter and nft twitter) we are more permissive than most social media sites on the following two factors:
  a. Typical cryptotwitter terms. Aka "shitposting" is fine as a term
  b. Nudity as we support nude art photographers
4. Personal Doxxing Information:  This is information that could dox a person’s identity such:
  a. Proper names (e.g. “John Hammersmith”)
  b. Indirect workarounds to the above (e.g. “John Hammersmith’s father”)
  c. You can assume that famous people’s names such are politicians, celebrities and athletes are not a concern and can be allowed
Organizational Doxxing Information:  This is information that could dox a person’s through their organizational affiliations such as: “CEO of Acme Enterprises” or “VP of Finance, Salesforce.com” or “the person who the VP of Finance at Acme Inc replaced last year”
Note further that people may submit classifications in different languages. Apply the same rules in that case, taking into account idiomatic use 

Format

The format of the task is as follows:
We will submit a classification.
You will return: 
The value: "Allowed" or "Disallowed"
The rationale of why it is disallowed, in the case you disallowed
You must return NO other text or explanations as you will be integrated into an automated workflow and we will not be able to understand the text.
I will share two examples of input and output.
Example 1:
input: "Software Developer "
Allowed
Example 2:
input: "fuckface"
Disallowed - Insulting Term
I will now put the classification request after the word "input" and make further requestions in that format.
input: ${text}
    `.trim();
    return await this.doCheck(message, text);
  }

  public async checkBioText(text: string): Promise<AbusivenessDetectionResult> {
    const message = `
Background

We operate a social media site in the cryptocurrency space, more specifically in the nft space. This website allows users to create profiles to verify their identity. Profiles can get "rep" (aka reputation) points from other community members for different activities or characteristics.
Each profile may have an “About” section, that lets the person or organization describe themselves in their own words.

Task

You are going to help us moderate this user-generated content of the About section, please.
Use the following guidelines:

1. We do not allow discriminatory or hate speech on any typical grounds
2. We do not allow Personal insults, even if a user directs it at themselves.
3. Generally words that would make a normal user in the cryptotwitter community feel bad or uncomfortable. Given the nature of the community (cryptotwitter and NFT twitter) we are more permissive than most social media sites on the following two factors:
  a. We allow typical cryptotwitter terms. Aka "shitposting" is fine as a term, as is “cryptodickbutt”, and “degen”.
  b. We allow discussion of artistic Nudity as we support nude art photographers.
4. A user’s About content should not contain any Personal Doxxing Information about anyone else: We don’t allow hints at or direct reference to anything that could doxx a person's identity such as:
  a. Disclosing other people’s proper names (e.g. “John Hammersmith”)
  b. Indirect workarounds to the above (e.g. “John Hammersmith's father”)
  c. You can assume that famous people's names such as politicians, celebrities, and athletes are not a concern and can be allowed.
  D. Disallow Organizational Doxxing Information when it’s about other people: This is information that could dox a person's through their organizational affiliations such as: “CEO of Acme Enterprises” or “VP of Finance, Salesforce.com” or “the person who the VP of Operations at Acme Inc replaced last year”

Note further that people may describe themselves in languages other than English. Apply the same rules in that case, taking into account idiomatic use.

Format

The format of the task is as follows:
We will submit text for classification.
You will return: 
The value: "Allowed" or "Disallowed"
The rationale of why it is disallowed, in the case you disallowed.
You must return NO other text or explanations as you will be integrated into an automated workflow and we will not be able to understand the text.
I will share two examples of input and output.

Example 1:
input: "Software Developer turned jpeg degen looking for the next shitcoin to moon."
Allowed

Example 2:
input: "i’m just a quiet community member who awaits the rise of the aryan nation."
Disallowed hate speech

Example 3:
input: "I collect NFTs… don’t you think Punku is really Vitalik?"
Disallowed doxxing

I will now put the classification request after the word "input" and make further requests in that format.

input: ${text}
    `.trim();
    return await this.doCheck(message, text);
  }

  private async doCheck(message: string, text: string) {
    const response = await this.supplyOpenAi().chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: message }]
    });

    const responseContent = response.choices[0].message.content?.replace(
      "\n",
      " "
    );
    if (!responseContent) {
      throw new Error(`OpenAI gave an empty response to given text`);
    }
    const responseTokens = responseContent.split(" ");
    const decision = responseTokens[0];
    const gptReason = responseTokens.slice(1).join(" ");
    const status = STATUS_MAPPINGS[decision];
    if (!status) {
      throw new Error(
        `Check against GPT failed. Input: ${text}. GPT response: ${responseContent}`
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
