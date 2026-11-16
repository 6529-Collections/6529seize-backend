import {
  ApiMainStageTraitRule,
  ApiMainStageTraitRuleTypeEnum as RuleType
} from '@/api/generated/models/ApiMainStageTraitRule';
import {
  ApiMainStageTraitIssue,
  ApiMainStageTraitIssueCodeEnum as IssueCode
} from '@/api/generated/models/ApiMainStageTraitIssue';
import { ApiDropMetadata } from '@/api/generated/models/ApiDropMetadata';
import { DROP_MAX_METADATA_ENTRIES } from '@/drops/drop-payload-limits';
import { CompetitionCapability } from '@/entities/ICompetition';
import { BadRequestException } from '@/exceptions';

const memeNames = [
  'Seize the Memes of Production',
  'WAGMI',
  "Don't Let the Institutions Steal Your JPGs",
  'GM',
  'Use a Hardware Wallet',
  'Open Metaverse / OM',
  'Freedom to Transact',
  'Freestyle',
  'Survive',
  'Not Your Keys, Not Your Coins',
  'Digital Rights Charter',
  'BUIDL',
  'TAP',
  'Summer.jpg',
  'Brain'
];

const minimumPoints = -10000000000;
const maximumPoints = 10000000000;

const rules: ApiMainStageTraitRule[] = [
  ...['title', 'description', 'artist'].map((key) => ({
    key,
    type: RuleType.Text,
    required: true
  })),
  { key: 'seizeArtistProfile', type: RuleType.Text, required: false },
  {
    key: 'memeName',
    type: RuleType.Choice,
    required: true,
    choices: memeNames
  },
  ...['pointsPower', 'pointsWisdom', 'pointsLoki', 'pointsSpeed'].map(
    (key) => ({
      key,
      type: RuleType.Points,
      required: true,
      minimum: minimumPoints,
      maximum: maximumPoints
    })
  ),
  ...[
    'punk6529',
    'gradient',
    'movement',
    'dynamic',
    'interactive',
    'collab',
    'om',
    'threeD',
    'pepe',
    'gm',
    'summer',
    'tulip'
  ].map((key) => ({
    key,
    type: RuleType.Boolean,
    required: false,
    default_value: 'false'
  })),
  {
    key: 'palette',
    type: RuleType.Choice,
    required: true,
    choices: ['Color', 'Black and White']
  },
  ...[
    'bonus',
    'boost',
    'style',
    'jewel',
    'superpower',
    'dharma',
    'gear',
    'clothing',
    'element',
    'mystery',
    'secrets',
    'weapon',
    'home',
    'parent',
    'sibling',
    'food',
    'drink'
  ].map((key) => ({
    key,
    type: RuleType.Text,
    required: false,
    default_value: 'No'
  }))
];

export function mainStageTraitRules(capabilities: readonly string[]) {
  const explicitlyEnabled = process.env.MAIN_STAGE_TRAIT_VALIDATION_ENABLED;
  const enabled =
    explicitlyEnabled === undefined
      ? process.env.NODE_ENV === 'development'
      : explicitlyEnabled === 'true';
  return enabled && capabilities.includes(CompetitionCapability.MAIN_STAGE)
    ? rules
    : undefined;
}

function validationIssue(rule: ApiMainStageTraitRule, value: string) {
  if (rule.type === RuleType.Choice && !rule.choices?.includes(value))
    return IssueCode.InvalidChoice;
  if (rule.type === RuleType.Boolean && value !== 'true' && value !== 'false')
    return IssueCode.InvalidBoolean;
  if (rule.type === RuleType.Points) {
    const points = Number(value);
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
      !Number.isFinite(points) ||
      points === 0 ||
      points < minimumPoints ||
      points > maximumPoints
    )
      return IssueCode.InvalidPoints;
  }
  return undefined;
}

export function checkMainStageTraits(
  metadata: readonly ApiDropMetadata[],
  traitRules: readonly ApiMainStageTraitRule[]
) {
  const items = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const { data_key, data_value } of metadata) {
    if (items.has(data_key)) duplicates.add(data_key);
    items.set(data_key, data_value);
  }
  const issues: ApiMainStageTraitIssue[] = [];
  const defaults: ApiDropMetadata[] = [];
  for (const rule of traitRules) {
    const { key, default_value } = rule;
    const value = items.get(key);
    if (duplicates.has(key)) {
      issues.push({ key, code: IssueCode.Duplicate });
    } else if (value === undefined) {
      if (rule.required) issues.push({ key, code: IssueCode.Required });
      if (default_value !== undefined) {
        defaults.push({ data_key: key, data_value: default_value });
      }
    } else {
      const code = validationIssue(rule, value);
      if (code) issues.push({ key, code });
    }
  }
  return { issues, defaults };
}

export function normalizeMainStageTraits(
  metadata: ApiDropMetadata[],
  capabilities: readonly string[]
): ApiDropMetadata[] {
  const traitRules = mainStageTraitRules(capabilities);
  if (!traitRules) return metadata;
  const { issues, defaults } = checkMainStageTraits(metadata, traitRules);
  if (issues.length) {
    throw new BadRequestException(
      `Invalid Main Stage traits: ${issues.map(({ key, code }) => `${key} (${code})`).join(', ')}`
    );
  }
  if (metadata.length + defaults.length > DROP_MAX_METADATA_ENTRIES) {
    throw new BadRequestException(
      'Too many metadata fields after applying Main Stage trait defaults'
    );
  }
  return [...metadata, ...defaults];
}
