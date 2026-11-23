import { buildRelayWorld } from '@/rebuild/world/waves/relay-world';
import { checkWavesRelayEvent } from './waves-relay-check';

describe('the waves relay check', () => {
  it("passes every event of the world's relay traffic", () => {
    for (const { event, grant } of buildRelayWorld()) {
      expect(
        checkWavesRelayEvent({
          event: event as { id: string; wave: string },
          grant
        })
      ).toEqual({ ok: true });
    }
  });

  it('fails an event edited after it was signed', () => {
    const [{ event, grant }] = buildRelayWorld();
    const edited = {
      ...event,
      body: String(event.body).replace('First', 'Edited')
    } as { id: string; wave: string };
    expect(checkWavesRelayEvent({ event: edited, grant })).toMatchObject({
      ok: false
    });
  });

  it('fails an event under a grant of another wallet', () => {
    const [{ event, grant }] = buildRelayWorld();
    expect(
      checkWavesRelayEvent({
        event: event as { id: string; wave: string },
        grant: { ...grant, wallet: `0x${'11'.repeat(20)}` }
      })
    ).toMatchObject({ ok: false });
  });
});
