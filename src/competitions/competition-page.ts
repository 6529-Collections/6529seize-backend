import {
  CompetitionPage,
  CompetitionPageRequest
} from '@/competitions/competition.types';

const INTERNAL_PAGE_SIZE = 500;

export async function collectCompetitionPages<T>(
  read: (request: CompetitionPageRequest) => Promise<CompetitionPage<T>>,
  direction: CompetitionPageRequest['direction'] = 'ASC'
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
    if (!page.has_more) return data;
    if (!page.data.length) {
      throw new Error('Competition page reported more data without progress');
    }
    offset += page.data.length;
  }
}
