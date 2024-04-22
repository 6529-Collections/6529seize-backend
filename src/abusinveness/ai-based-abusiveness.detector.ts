import { AbusivenessDetectionResult } from '../entities/IAbusivenessDetectionResult';
import { discord, Discord, DiscordChannel } from '../discord';
import { AiPrompter } from './ai-prompter';
import { bedrockAiPrompter } from './bedrock-ai.prompter';

const preamble = `
Background:
We operate a social media site in the cryptocurrency space, more specifically in the nft space.

You are going to help us moderate the content on our site. 
We have a set of rules that we need to enforce, based on the presumed intentions of the user submitting content.

The general guideline is that all content is allowed. 
We only want to restrict the following five categories, but there are exceptions even there. 

Not allowed (with exceptions noted below):
1. Discriminatory or hate speech on any typical grounds
2. Personal insults are disallowed, but there are exceptions:
  a. Allowed: Insults that are clearly in jest or part of a meme.
  b. Allowed: references to mfers, complainoors, karens, or Major Karen Pepe.
3. Generally words that would make a normal user in the cryptotwitter community feel bad or uncomfortable. Given the nature of the community (cryptotwitter and nft twitter) we are more permissive than most social media sites on the following two factors:
  a. Allowed: Typical cryptotwitter terms. Aka "shitposting" is fine as a term, as is: maxi, cryptodickbutt, cabal, n00b, newbie, nerd, and degen.
  b. Allowed: Nudity as we support nude art photographers
  c. Allowed: WWOH is a fictional story, so references to people therein are not considered doxxing.
  d. Allowed: Seemingly-random words or phrases that are not clearly doxxing or hate speech. 
4. Personal Doxxing Information: This is information that could reveal a person's identity such:
  a. Proper names (e.g. “John Hammersmith”)
  b. Indirect workarounds to the above (e.g. “John Hammersmith's father”)
  c. Allowed: You can assume that famous people's names such are politicians, celebrities and athletes are not a concern and can be allowed.
  d. Allowed: Identifying artists by using their proper name is allowed
  e. Allowed: Personal names in the context of things like being their collector, a maxi, appreciating, supporting their art is allowed.
5. Organizational Doxxing Information:  This is information that could dox a person's through their organizational affiliations such as: “CEO of Acme Enterprises” or “VP of Finance, Salesforce.com” or “the person who the VP of Finance at Acme Inc replaced last year”

Note further that people may submit content in different languages. 
Apply the same rules in that case, taking into account idiomatic use 

Format:
Please help by reviewing the user input and determining if it is allowed or disallowed based on the above guidelines.

Your response will be a JSON object.

You must return NO OTHER TEXT or explanations as you will be integrated into an automated workflow and we will not be able to understand the text.
Your response should strictly follow the JSON format and the field names should be exactly as specified below.
Start and end the JSON with curly braces. 
Include NOTHING before or after. 

The specifics of what you are reviewing is provided below.
`;

const STATUS_MAPPINGS: Record<string, 'ALLOWED' | 'DISALLOWED'> = {
  Allowed: 'ALLOWED',
  Disallowed: 'DISALLOWED'
};

export class AiBasedAbusivenessDetector {
  constructor(
    private readonly aiPrompter: AiPrompter,
    private readonly discord: Discord
  ) {}

  public async checkRepPhraseText(
    text: string
  ): Promise<AbusivenessDetectionResult> {
    const prompt = `
    ${preamble}
    Our website allows us to give "rep" (aka reputation) points to community members for different activities or characteristics.
    some valid examples below, that show the rep points being assigned and the classification for each rep:
    +1,000 for "Solidity Programming" 
    +500 for "nude photography" 
    +4,200 for "Pizza Cooking" +6,969 for "Kindness"
    -4,200 for "phishing" 
    -100 for "Unreliable" 
    +5,000 for "teaching" 
    +7,540 for "History of Carthage" 
    +4,000 for "cold showers" 
    +4,444 for "bitcoin mining"
    +1,069 for "Rakesh Collector"
    +420 for "Paul Reid Maxi"
    
    Task
    
    You are going to help us moderate user-generated rep classifications.
  
    I will share two examples of input and output.
    
    Example 1:
    
    Input: 
    Software Developer
    Your Output:
    {"value": "Allowed", self_dox: "No"}
    
    Example 2:
    
    Input:
    fuckface
    Your Output:
    {"value": "Disallowed", self_dox: "No", "reason": "Insulting term"}
    
    I will now put the classification request after the word "input" and you respond with a single classificiation.
    
    Input:
${text}
    `.trim();
    const responseMessage = await this.aiPrompter.promptAndGetReply(prompt);
    if (process.env.NODE_ENV !== 'local') {
      await this.discord.sendMessage(
        DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
        `\n\nRep check:\n  Environment: \`${
          process.env.NODE_ENV
        }\`\n  Input text: \`${text}\`\n  GPT response:\n\`\`\`json\n${responseMessage.substring(
          0,
          1069
        )}\n\`\`\``
      );
    }
    return await this.formatChatResponse(text, responseMessage);
  }

  public async checkBioText({
    text,
    handle,
    profile_type
  }: {
    text: string;
    handle: string;
    profile_type: string;
  }): Promise<AbusivenessDetectionResult> {
    const prompt = `
${preamble}

Each profile may have an “About” section, that lets the person or organization describe themselves in their own words.

Task:

You are going to help us confirm that a user is not using their “About” section to violate the rules and policies of the website.

Username:

We will submit the username of the user whose “About” section you are evaluating, along with their account type: Government Name, Pseudonymous, Organization, Bot or AI

Take their username into account when analyzing the About section.
They are allowed to make comments about themselves but they are not allowed to use the About section to make comments about others.

Keep in mind that UserName and AccountType are self-declared and therefore not certain to be true. 

Additional Guidelines:
For avoidance of doubt, users are allowed to dox themselves. 
If someone's profile is “NFTDegen” and their About text is “I work at Goldman Sachs and love NFTs”, it is OK.

Language
Note further that people may describe themselves in languages other than English. Apply the same rules in that case, taking into account idiomatic use.

You will return a single JSON object with the following fields:
value - "Allowed" or "Disallowed"
self_dox - This field is only set if the value is "Allowed". If there is a self-dox in the text then the value is “Yes”, otherwise the value is “No”
reason - This field is only set if you Disallowed and contains the reason you disallowed, picking only from the following values:
  - “Hate Speech”
  - “Personal Insults”
  - “Inappropriate Language”
  - “Doxxing of Another Person”

Examples of Input and Output

Example 1:

Our Input: 
{"username": "NFTGod", "usertype": "Pseudonymous", "about_text": "I am an NFT God, king of kings"}

Your Output:
{"value": "Allowed", "self_dox": "No"}

Example 2:

Our Input: 
{"username": "NFTGod", "usertype": "Pseudonymous", "about_text": "I am John Smith and work at Goldman Sachs"}

Your Output:
{"value": "Allowed", "self_dox": "Yes"}

Example 3:

Our Input: 
{"username": "JohnSmith", "usertype": "Government Name", "about_text": "I am just a quiet community member waiting for the rise of the Aryan Nation"}

Your Output:
{"value": "Disallowed", "reason": "Hate Speech"}

Example 4:

Our Input: 

{"username": "MeMu", "usertype": "Bot", "about_text": "I collect NFTs… don't you think Punku is really Vitalik?"}

Your Output:

{"value": "Disallowed", "reason": "Doxxing Of Another Person"}

I will now put the classification request after the word "Input" and make further requests in that format.

Input
{"username": "${handle}", "usertype": "${profile_type}", "about_text": "${text}"}
    `.trim();
    const responseMessage = await this.aiPrompter.promptAndGetReply(prompt);
    if (process.env.NODE_ENV !== 'local') {
      await this.discord.sendMessage(
        DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
        `\n\nAbout check:\n  Environment: \`${
          process.env.NODE_ENV
        }\`\n  Input username: \`${handle}\`\n  Type: ${profile_type}\n  About text:\n\`\`\`${text}\`\`\`\n  GPT response:\n\`\`\`json\n${responseMessage.substring(
          0,
          1069
        )}\n\`\`\``
      );
    }
    return await this.formatChatResponse(text, responseMessage);
  }

  public async checkCurationName({
    text,
    handle
  }: {
    text: string;
    handle: string;
  }): Promise<AbusivenessDetectionResult> {
    const prompt = `
${preamble}

This website allows users to create profiles to verify their identity.  

Each profile may create search filters that help them in different searches across the website. 
Each such filter has a name which is freeform text.

Task:

You are going to help us confirm that a user is not using the filter name section to violate the rules and policies of the website.

Username:
We will submit the username of the user whose filter is about to be saved and the filter name you are evaluating.

Take their username into account when analyzing the filter name.
They are allowed to make comments about themselves but they are not allowed to use the filter name to make comments about others.

For avoidance of doubt, users are allowed to dox themselves.
If someone's profile is “NFTDegen” and their filter name can be “Creator of this filter works at Goldman Sachs and loves NFTs”, it is OK

Language
Note further that people may describe themselves in languages other than English. Apply the same rules in that case, taking into account idiomatic use.

Format

The format of the task is as follows:

We will send our request as a JSON and you will respond with a JSON. Our request JSON contains the following fields: username, filter_name.

You will return a JSON with the following fields:
value - Allowed or Disallowed
self_dox - This field is only set if you Allowed. If there is a self-dox in the text then the value is “Yes”, otherwise the value is “No”
reason - This field is only set if you Disallowed and contains the reason you disallowed, picking only from the following values:
“Hate Speech”
“Personal Insults”
“Inappropriate Language”
“Doxxing of Another Person”

Examples of Input and Output

Example 1:
Our Input: 
{"username": "NFTGod", "filter_name": "I am an NFT God, king of kings"}

Your Output:
{"value": "Allowed", "self_dox": "No"}

Example 2:
Our Input: 

{"username": "NFTGod", "filter_name": "I am John Smith and work at Goldman Sachs"}

Your Output:
{"value": "Allowed", "self_dox": "Yes"}

Example 3:
Our Input: 
{"username": "JohnSmith", "filter_name": "I am just a quiet community member waiting for the rise of the Aryan Nation"}

Your Output:
{"value": "Disallowed", "reason": "Hate Speech"}

Example 4:
Our Input: 

{"username": "MeMu", "filter_name": "I collect NFTs… don't you think Punku is really Vitalik?"}

Your Output:

{"value": "Disallowed", "reason": "Doxxing Of Another Person"}

I will now put the classification request after the word "input" and make further requests in that format.

input
{"username": "${handle}", "filter_name": "${text}"}
    `.trim();
    const responseMessage = await this.aiPrompter.promptAndGetReply(prompt);
    if (process.env.NODE_ENV !== 'local') {
      await this.discord.sendMessage(
        DiscordChannel.OPENAI_BIO_CHECK_RESPONSES,
        `Curation criteria name check:\n  Environment: \`${
          process.env.NODE_ENV
        }\`\n  Username: \`${handle}\`\n  Curation name: \`${text}\`\n  GPT response:\n\`\`\`json\n${responseMessage.substring(
          0,
          1069
        )}\n\`\`\``
      );
    }
    return await this.formatChatResponse(text, responseMessage);
  }

  private async formatChatResponse(text: string, response: string) {
    const indexOfJson = response.indexOf('{');
    let parsedResponse: GptResponseJson;
    if (indexOfJson === -1) {
      parsedResponse = {
        value: 'Unknown',
        reason: 'Invalid response ' + response
      };
    } else {
      const s = response.slice(indexOfJson);
      const endIndex = s.indexOf('}');
      if (endIndex === -1) {
        parsedResponse = {
          value: 'Unknown',
          reason: 'Invalid response ' + response
        };
      } else {
        parsedResponse = JSON.parse(s.substring(0, endIndex + 1));
      }
    }

    if (!parsedResponse) {
      throw new Error(`AI gave an empty response to given text`);
    }
    const decision = parsedResponse.value;
    const gptReason = parsedResponse.reason ?? '';
    const status = STATUS_MAPPINGS[decision];
    if (!status) {
      throw new Error(
        `Check against GPT failed. Input: ${text}. GPT response: ${JSON.stringify(
          parsedResponse
        )}`
      );
    }
    return {
      text,
      status,
      explanation: gptReason,
      external_check_performed_at: new Date()
    };
  }
}

interface GptResponseJson {
  value: string;
  self_dox?: string;
  reason?: string;
}

export const aiBasedAbusivenessDetector = new AiBasedAbusivenessDetector(
  bedrockAiPrompter,
  discord
);
