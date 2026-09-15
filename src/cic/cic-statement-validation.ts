import { BadRequestException } from '../exceptions';
import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';

export const MAX_NFT_ACCOUNT_STATEMENTS = 20;
export const MAX_ART_LINK_LENGTH = 2048;
export const MAX_CUSTOM_ART_LINK_LABEL_LENGTH = 40;

const CUSTOM_ART_LINK_TYPE = 'LINK';
const NINFA_STATEMENT_TYPE = 'NINFA';
const RESERVED_CUSTOM_LABELS = new Set(
  [
    'Art Blocks',
    'Deca Art',
    'Foundation',
    'KnownOrigin',
    'Link',
    'MakersPlace',
    'Manifold',
    'Ninfa',
    'OnCyber',
    'OpenSea',
    'Other',
    'Pepe.wtf',
    'SuperRare',
    'The Line',
    'Transient'
  ].map((label) => label.toLowerCase())
);

type CicStatementDraft = Omit<CicStatement, 'id' | 'crated_at'>;

function hasInvalidCustomLabelCharacter(label: string): boolean {
  return Array.from(label).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === '<' ||
      character === '>' ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x61c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
}

function parseSecureArtLink(value: string): URL {
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue.length > MAX_ART_LINK_LENGTH) {
    throw new BadRequestException(
      `NFT account URL must be 1-${MAX_ART_LINK_LENGTH} characters long`
    );
  }

  let url: URL;
  try {
    url = new URL(trimmedValue);
  } catch {
    throw new BadRequestException('NFT account URL must be a valid HTTPS URL');
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new BadRequestException(
      'NFT account URL must use HTTPS and must not include credentials'
    );
  }

  if (url.toString().length > MAX_ART_LINK_LENGTH) {
    throw new BadRequestException(
      `NFT account URL must be 1-${MAX_ART_LINK_LENGTH} characters long`
    );
  }
  return url;
}

function normalizeCustomArtLinkLabel(label: string | null): string {
  const normalizedLabel = label?.normalize('NFKC').trim() ?? '';
  const labelLength = Array.from(normalizedLabel).length;
  if (
    labelLength < 1 ||
    labelLength > MAX_CUSTOM_ART_LINK_LABEL_LENGTH ||
    hasInvalidCustomLabelCharacter(normalizedLabel)
  ) {
    throw new BadRequestException(
      `Custom art link label must be 1-${MAX_CUSTOM_ART_LINK_LABEL_LENGTH} characters and cannot contain HTML, control, or bidirectional formatting characters`
    );
  }
  if (RESERVED_CUSTOM_LABELS.has(normalizedLabel.toLowerCase())) {
    throw new BadRequestException(
      'Custom art link label must not use a built-in platform name'
    );
  }
  return normalizedLabel;
}

export function prepareCicStatementForInsert(
  statement: CicStatementDraft
): CicStatementDraft {
  if (statement.statement_group !== CicStatementGroup.NFT_ACCOUNTS) {
    return statement;
  }

  const url = parseSecureArtLink(statement.statement_value);
  if (statement.statement_type === NINFA_STATEMENT_TYPE) {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'ninfa.io' && !hostname.endsWith('.ninfa.io')) {
      throw new BadRequestException(
        'Ninfa URL must use ninfa.io or a ninfa.io subdomain'
      );
    }
    return {
      ...statement,
      statement_comment: null,
      statement_value: url.toString()
    };
  }

  if (statement.statement_type === CUSTOM_ART_LINK_TYPE) {
    return {
      ...statement,
      statement_comment: normalizeCustomArtLinkLabel(
        statement.statement_comment
      ),
      statement_value: url.toString()
    };
  }

  return { ...statement, statement_value: url.toString() };
}

function getComparableArtLink(value: string): string | null {
  try {
    const url = parseSecureArtLink(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function validateNftAccountStatementConstraints(
  statement: CicStatementDraft,
  existingStatements: CicStatement[]
): void {
  if (statement.statement_group !== CicStatementGroup.NFT_ACCOUNTS) {
    return;
  }

  const existingNftAccounts = existingStatements.filter(
    (existingStatement) =>
      existingStatement.statement_group === CicStatementGroup.NFT_ACCOUNTS
  );
  const comparableUrl = getComparableArtLink(statement.statement_value);
  const isDuplicate = existingNftAccounts.some(
    (existingStatement) =>
      comparableUrl !== null &&
      getComparableArtLink(existingStatement.statement_value) === comparableUrl
  );
  if (isDuplicate) {
    throw new BadRequestException(
      'This NFT account URL is already on the profile'
    );
  }
  if (existingNftAccounts.length >= MAX_NFT_ACCOUNT_STATEMENTS) {
    throw new BadRequestException(
      `Profiles can have at most ${MAX_NFT_ACCOUNT_STATEMENTS} NFT account links`
    );
  }
}
