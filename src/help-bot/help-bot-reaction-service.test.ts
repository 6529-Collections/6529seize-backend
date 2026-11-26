import { BotDeviceSigner } from '@/api/device-signing/bot-device-signer';
import { signingBot } from '@/tests/fixtures/bot-device-signing.fixture';
import { HelpBotReactionService } from './help-bot-reaction.service';

function service(signer: BotDeviceSigner, changed = true) {
  const reactionsDb = { addReaction: jest.fn().mockResolvedValue(changed) };
  const dropsService = {
    findDropByIdOrThrow: jest.fn().mockResolvedValue({ id: 'drop-1' })
  };
  const notifier = { notifyAboutDropReactionUpdate: jest.fn() };
  return {
    reactionsDb,
    notifier,
    service: new HelpBotReactionService(
      reactionsDb as never,
      dropsService as never,
      notifier as never,
      signer
    )
  };
}

const reaction = {
  botProfileId: 'bot-profile',
  dropId: 'drop-1',
  waveId: 'wave-1',
  reaction: ':eyes:'
};

describe('HelpBotReactionService', () => {
  it('signs the reaction when the bot has a device key', async () => {
    const { signer, store } = await signingBot({ profileId: 'bot-profile' });
    const { service: reactions, reactionsDb, notifier } = service(signer);

    await reactions.setReaction(reaction, {});

    expect(reactionsDb.addReaction).toHaveBeenCalledWith(
      'bot-profile',
      'drop-1',
      'wave-1',
      ':eyes:',
      expect.anything()
    );
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      kind: 4,
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      refs: JSON.stringify(['drop-1']),
      body: '{"on":true,"reaction":":eyes:"}'
    });
    expect(notifier.notifyAboutDropReactionUpdate).toHaveBeenCalled();
  });

  it('reacts unsigned when the bot has no device key', async () => {
    const { signer, store } = await signingBot({
      profileId: 'bot-profile',
      setting: ''
    });
    const { service: reactions, reactionsDb } = service(signer, false);

    await reactions.setReaction(reaction, {});

    expect(reactionsDb.addReaction).toHaveBeenCalledTimes(1);
    expect(store.events).toHaveLength(0);
    expect(store.grants.size).toBe(0);
  });
});
