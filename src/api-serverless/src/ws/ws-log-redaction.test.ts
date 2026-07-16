import { redactWebSocketMessageForLog } from '@/api/ws/ws-log-redaction';
import { WsMessageType } from '@/api/ws/ws-message';

describe('redactWebSocketMessageForLog', () => {
  it('does not log authenticate bearer tokens', () => {
    expect(
      redactWebSocketMessageForLog({
        type: WsMessageType.AUTHENTICATE,
        access_token: 'live-jwt',
        token: 'legacy-token'
      })
    ).toEqual({ type: WsMessageType.AUTHENTICATE });
  });

  it('redacts token-shaped fields on other message types', () => {
    expect(
      redactWebSocketMessageForLog({
        type: WsMessageType.SUBSCRIBE_TO_WAVE,
        wave_id: 'wave-1',
        token: 'accidental-token'
      })
    ).toEqual({
      type: WsMessageType.SUBSCRIBE_TO_WAVE,
      wave_id: 'wave-1',
      token: '[REDACTED]'
    });
  });

  it('redacts token-bearing websocket messages inside arrays', () => {
    expect(
      redactWebSocketMessageForLog([
        {
          type: WsMessageType.AUTHENTICATE,
          access_token: 'live-jwt'
        },
        {
          type: WsMessageType.SUBSCRIBE_TO_WAVE,
          wave_id: 'wave-1',
          token: 'accidental-token'
        }
      ])
    ).toEqual([
      { type: WsMessageType.AUTHENTICATE },
      {
        type: WsMessageType.SUBSCRIBE_TO_WAVE,
        wave_id: 'wave-1',
        token: '[REDACTED]'
      }
    ]);
  });

  it('does not log notification identity bearer tokens', () => {
    expect(
      redactWebSocketMessageForLog({
        type: WsMessageType.SYNC_NOTIFICATION_IDENTITIES,
        access_tokens: ['primary-jwt', 'secondary-jwt']
      })
    ).toEqual({ type: WsMessageType.SYNC_NOTIFICATION_IDENTITIES });
  });
});
