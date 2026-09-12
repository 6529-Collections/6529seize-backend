import { CicStatement, CicStatementGroup } from '@/entities/ICICStatement';
import { ModerationPresentationService } from './moderation-presentation.service';
import { moderationFingerprint } from './moderation-review.types';

describe('ModerationPresentationService', () => {
  const suppressedSubjects = jest.fn<
    Promise<Set<string>>,
    [string, ReadonlyArray<{ id: string; revision: string }>, object]
  >();
  const service = new ModerationPresentationService({ suppressedSubjects });
  const ctx = {};
  const statement = (id: string, text: string): CicStatement => ({
    id,
    profile_id: 'profile-1',
    statement_group: CicStatementGroup.GENERAL,
    statement_type: 'BIO',
    statement_value: text,
    statement_comment: 'Original comment',
    crated_at: new Date()
  });

  beforeEach(() => {
    suppressedSubjects.mockReset();
    suppressedSubjects.mockResolvedValue(new Set());
  });

  it('hides only the reviewed BIO revision and retains the stored source', async () => {
    const oldBio = statement('old-bio', 'Reviewed content');
    const newBio = statement('new-bio', 'Edited content');
    const email = {
      ...statement('email', 'hello@example.com'),
      statement_group: CicStatementGroup.CONTACT,
      statement_type: 'EMAIL'
    };
    const revision = moderationFingerprint({
      id: oldBio.id,
      text: oldBio.statement_value
    });
    suppressedSubjects.mockResolvedValue(new Set([`profile-1:${revision}`]));

    const visible = await service.cicStatements([oldBio, newBio, email], ctx);

    expect(visible[0]).toMatchObject({
      id: oldBio.id,
      statement_value: '',
      statement_comment: null
    });
    expect(visible[1]).toBe(newBio);
    expect(visible[2]).toBe(email);
    expect(oldBio.statement_value).toBe('Reviewed content');
    expect(suppressedSubjects).toHaveBeenCalledTimes(1);
    expect(suppressedSubjects).toHaveBeenCalledWith(
      'PROFILE_BIO',
      [
        { id: 'profile-1', revision },
        {
          id: 'profile-1',
          revision: moderationFingerprint({
            id: newBio.id,
            text: newBio.statement_value
          })
        }
      ],
      ctx
    );
  });

  it('omits a suppressed latest BIO without exposing an earlier revision', async () => {
    const bios = [
      { id: 'bio-1', profile_id: 'profile-1', bio: 'Reviewed content' },
      { id: 'bio-2', profile_id: 'profile-2', bio: 'Unchanged content' }
    ];
    suppressedSubjects.mockResolvedValue(
      new Set([
        `profile-1:${moderationFingerprint({ id: 'bio-1', text: 'Reviewed content' })}`
      ])
    );
    expect(await service.profileBios(bios, ctx)).toEqual([bios[1]]);
    expect(bios).toHaveLength(2);
  });

  it('keeps group IDs stable and applies names in one batch without mutating entities', async () => {
    const groups = [
      { id: 'one', name: 'Reviewed name' },
      { id: 'two', name: 'Other name' }
    ];
    const revision = moderationFingerprint({ text: 'Reviewed name' });
    suppressedSubjects.mockResolvedValue(new Set([`one:${revision}`]));
    expect(await service.groupNames(groups, ctx)).toEqual({
      one: 'Name hidden by moderation',
      two: 'Other name'
    });
    expect(groups[0].name).toBe('Reviewed name');
    expect(suppressedSubjects).toHaveBeenCalledTimes(1);
    expect(suppressedSubjects).toHaveBeenCalledWith(
      'GROUP_NAME',
      [
        { id: 'one', revision },
        { id: 'two', revision: moderationFingerprint({ text: 'Other name' }) }
      ],
      ctx
    );
  });
});
