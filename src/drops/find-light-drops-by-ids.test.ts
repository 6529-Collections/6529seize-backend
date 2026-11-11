import { DropsDb } from './drops.db';

function repoWithExecute() {
  const execute = jest.fn().mockResolvedValue([]);
  const repo = new DropsDb(() => ({ execute }) as any);
  return { repo, execute };
}

describe('DropsDb.findLightDropsByIds', () => {
  it('limits hydrated drops to waves readable with the given groups', async () => {
    const { repo, execute } = repoWithExecute();
    await repo.findLightDropsByIds(['d1', 'd2'], ['g1', 'g2'], {});

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('where d.id in (:dropIds)');
    expect(sql).toContain('w.visibility_group_id is null');
    expect(sql).toContain(
      'w.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(sql).toContain(
      'access_parent.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(params).toEqual({
      dropIds: ['d1', 'd2'],
      groupsUserIsEligibleFor: ['g1', 'g2']
    });
  });

  it('limits a viewer without groups to public waves', async () => {
    const { repo, execute } = repoWithExecute();
    await repo.findLightDropsByIds(['d1'], [], {});

    const [sql] = execute.mock.calls[0];
    expect(sql).toContain('w.visibility_group_id is null');
    expect(sql).toContain('access_parent.visibility_group_id is null');
    expect(sql).not.toContain('in (:groupsUserIsEligibleFor)');
  });

  it('queries nothing for an empty id list', async () => {
    const { repo, execute } = repoWithExecute();
    await expect(repo.findLightDropsByIds([], ['g1'], {})).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
