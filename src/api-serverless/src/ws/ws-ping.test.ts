import { pongFrame, readPingFrame, WS_PING_MAX_FRAME_BYTES } from './ws-ping';

describe('WebSocket PING frames', () => {
  it.each(['a', 'resume-01', 'A_b.c:d-9', 'x'.repeat(32)])(
    'reads a valid PING id %s',
    (id) => {
      expect(readPingFrame(JSON.stringify({ type: 'PING', id }))).toEqual({
        kind: 'ping',
        id
      });
    }
  );

  it.each([
    ['an empty id', { type: 'PING', id: '' }],
    ['a 33-character id', { type: 'PING', id: 'x'.repeat(33) }],
    ['a space', { type: 'PING', id: 'a b' }],
    ['a quote', { type: 'PING', id: 'a"b' }],
    ['a non-string id', { type: 'PING', id: 7 }],
    ['a missing id', { type: 'PING' }],
    ['an extra field', { type: 'PING', id: 'a', access_token: 't' }]
  ])('refuses a PING with %s', (_name, frame) => {
    expect(readPingFrame(JSON.stringify(frame))).toEqual({ kind: 'invalid' });
  });

  it.each([
    ['another type', JSON.stringify({ type: 'PONG', id: 'a' })],
    [
      'a typing frame',
      JSON.stringify({ type: 'USER_IS_TYPING', wave_id: 'PING' })
    ],
    ['an array', JSON.stringify(['PING'])],
    ['malformed JSON', '{"type":"PING"'],
    ['an empty body', ''],
    ['no body', undefined],
    [
      'an oversized frame',
      JSON.stringify({
        type: 'PING',
        id: 'a',
        pad: 'p'.repeat(WS_PING_MAX_FRAME_BYTES)
      })
    ]
  ])('leaves %s to the normal path', (_name, body) => {
    expect(readPingFrame(body)).toBeNull();
  });

  it('echoes the id in the PONG', () => {
    expect(JSON.parse(pongFrame('resume-01'))).toEqual({
      type: 'PONG',
      id: 'resume-01'
    });
  });
});
