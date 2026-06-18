import { DropCreationApiService } from './drop-creation.api.service';

function makeService({
  currentHidden,
  returnedHidden
}: {
  readonly currentHidden: boolean;
  readonly returnedHidden?: boolean | undefined;
}) {
  const dropsService = {
    findDropByIdOrThrow: jest.fn().mockResolvedValue({
      id: 'drop-1',
      hide_link_preview: returnedHidden ?? currentHidden
    })
  };
  const dropsDb = {
    findDropById: jest.fn().mockResolvedValue({
      id: 'drop-1',
      author_id: 'profile-1',
      hide_link_preview: currentHidden
    }),
    updateHideLinkPreview: jest.fn()
  };
  const wsListenersNotifier = {
    notifyAboutDropUpdate: jest.fn()
  };
  const service = new DropCreationApiService(
    dropsService as never,
    dropsDb as never,
    {} as never,
    {} as never,
    {} as never,
    wsListenersNotifier as never,
    {} as never,
    {} as never,
    {} as never
  );
  const ctx = {
    authenticationContext: {
      getActingAsId: jest.fn().mockReturnValue('profile-1'),
      isAuthenticatedAsProxy: jest.fn().mockReturnValue(false)
    },
    timer: {
      start: jest.fn(),
      stop: jest.fn()
    }
  };

  return {
    ctx,
    dropsDb,
    dropsService,
    service,
    wsListenersNotifier
  };
}

describe('DropCreationApiService.toggleHideLinkPreview', () => {
  it('keeps legacy toggle behavior when no final state is provided', async () => {
    const { ctx, dropsDb, service } = makeService({ currentHidden: false });

    await service.toggleHideLinkPreview({ dropId: 'drop-1' }, ctx as never);

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: true },
      ctx
    );
  });

  it('sets previews hidden when an explicit hidden state is provided', async () => {
    const { ctx, dropsDb, service } = makeService({ currentHidden: false });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: true },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: true },
      ctx
    );
  });

  it('restores previews when an explicit visible state is provided', async () => {
    const { ctx, dropsDb, service } = makeService({ currentHidden: true });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: false },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).toHaveBeenCalledWith(
      { drop_id: 'drop-1', hide_link_preview: false },
      ctx
    );
  });

  it('does not write or notify when explicit state already matches', async () => {
    const { ctx, dropsDb, service, wsListenersNotifier } = makeService({
      currentHidden: true
    });

    await service.toggleHideLinkPreview(
      { dropId: 'drop-1', hideLinkPreview: true },
      ctx as never
    );

    expect(dropsDb.updateHideLinkPreview).not.toHaveBeenCalled();
    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
  });
});
