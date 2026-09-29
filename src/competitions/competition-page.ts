import {
  CompetitionPage,
  CompetitionPageRequest
} from '@/competitions/competition.types';

const INTERNAL_PAGE_SIZE = 500;

export class CompetitionRowLimitError extends Error {
  constructor() {
    super('Competition sample exceeds row limit');
    this.name = 'CompetitionRowLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function collectCompetitionPages<T>(
  read: (request: CompetitionPageRequest) => Promise<CompetitionPage<T>>,
  direction: CompetitionPageRequest['direction'] = 'ASC',
  maxRows = Number.POSITIVE_INFINITY
): Promise<T[]> {
  const data: T[] = [];
  let offset = 0;
  while (true) {
    const page = await read({
      offset,
      limit: INTERNAL_PAGE_SIZE,
      direction
    });
    data.push(...page.data);
    if (data.length > maxRows || (data.length === maxRows && page.has_more)) {
      throw new CompetitionRowLimitError();
    }
    if (!page.has_more) return data;
    if (!page.data.length) {
      throw new Error('Competition page reported more data without progress');
    }
    offset += page.data.length;
  }
}
