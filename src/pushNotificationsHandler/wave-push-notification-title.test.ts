import {
  appendWavePushNotificationContext,
  buildAllDropsPushNotificationTitle,
  buildWavePushNotificationContext,
  buildWavePushNotificationTitle
} from './wave-push-notification-title';
import type { WavePushNotificationContext } from './wave-push-notification-title';

describe('wave push notification titles', () => {
  const waveContext: WavePushNotificationContext = {
    kind: 'wave',
    label: 'WaveName'
  };
  const dmContext: WavePushNotificationContext = {
    kind: 'dm',
    label: 'DM'
  };
  const groupDmContext: WavePushNotificationContext = {
    kind: 'group-dm',
    label: 'Group DM with userC'
  };

  it.each([
    ['message', waveContext, 'userA posted · WaveName'],
    ['message', dmContext, 'userA messaged you · DM'],
    ['message', groupDmContext, 'userA messaged · Group DM with userC'],
    ['reply', waveContext, 'userA replied · WaveName'],
    ['reply', dmContext, 'userA replied · DM'],
    ['reply', groupDmContext, 'userA replied · Group DM with userC'],
    ['mention', waveContext, 'userA mentioned you · WaveName'],
    ['mention', dmContext, 'userA mentioned you · DM'],
    ['mention', groupDmContext, 'userA mentioned you · Group DM with userC'],
    ['quote', waveContext, 'userA quoted you · WaveName'],
    ['quote', dmContext, 'userA quoted you · DM'],
    ['quote', groupDmContext, 'userA quoted you · Group DM with userC'],
    ['invite', waveContext, 'userA invited you · WaveName'],
    ['invite', dmContext, 'userA started a DM'],
    ['invite', groupDmContext, 'userA added you · Group DM with userC']
  ] as const)('formats %s for %s context', (type, context, expected) => {
    expect(
      buildWavePushNotificationTitle({
        actorHandle: 'userA',
        action: { type },
        context
      })
    ).toBe(expected);
  });

  it.each([
    [waveContext, 'userA reacted 🔥 · WaveName'],
    [dmContext, 'userA reacted 🔥 · DM'],
    [groupDmContext, 'userA reacted 🔥 · Group DM with userC']
  ])('formats reactions for %s context', (context, expected) => {
    expect(
      buildWavePushNotificationTitle({
        actorHandle: 'userA',
        action: { type: 'reaction', reaction: '🔥' },
        context
      })
    ).toBe(expected);
  });

  it('uses the wave name for non-DM context', () => {
    expect(
      buildWavePushNotificationContext({
        waveName: 'WaveName',
        isDirectMessage: false,
        participantHandles: [],
        participantCount: 0,
        actorHandle: 'userA',
        recipientHandle: 'userB'
      })
    ).toEqual(waveContext);
  });

  it('uses DM for a two-person conversation', () => {
    expect(
      buildWavePushNotificationContext({
        waveName: 'DM - userA / userB',
        isDirectMessage: true,
        participantHandles: ['userA', 'userB'],
        participantCount: 2,
        actorHandle: 'userA',
        recipientHandle: 'userB'
      })
    ).toEqual(dmContext);
  });

  it('describes a group DM without repeating the actor or recipient', () => {
    expect(
      buildWavePushNotificationContext({
        waveName: 'DM - userA / userB / userC',
        isDirectMessage: true,
        participantHandles: ['userA', 'userB', 'userC'],
        participantCount: 3,
        actorHandle: 'USERA',
        recipientHandle: 'userb'
      })
    ).toEqual(groupDmContext);
  });

  it('uses group DM when a three-person conversation has a missing handle', () => {
    expect(
      buildWavePushNotificationContext({
        waveName: 'Three-person DM',
        isDirectMessage: true,
        participantHandles: ['userA', 'userB', null],
        participantCount: 3,
        actorHandle: 'userA',
        recipientHandle: 'userB'
      })
    ).toEqual({
      kind: 'group-dm',
      label: 'Group DM'
    });
  });

  it('truncates larger group DM context to one handle and a count', () => {
    expect(
      buildWavePushNotificationContext({
        waveName: 'Large DM',
        isDirectMessage: true,
        participantHandles: ['userA', 'userB', 'userC', 'userD', 'userE'],
        participantCount: 5,
        actorHandle: 'userA',
        recipientHandle: 'userB'
      })
    ).toEqual({
      kind: 'group-dm',
      label: 'Group DM with userC +2'
    });
  });

  it('appends context to other wave-scoped notification titles', () => {
    expect(
      appendWavePushNotificationContext(
        'userA boosted your drop 🔥',
        waveContext
      )
    ).toBe('userA boosted your drop 🔥 · WaveName');
  });

  it.each([
    [42, 'userA rated a drop: +42 · WaveName'],
    ['42', 'userA rated a drop: +42 · WaveName'],
    ['-12', 'userA rated a drop: -12 · WaveName'],
    [0, 'userA rated a drop: 0 · WaveName'],
    ['0', 'userA rated a drop: 0 · WaveName']
  ])('formats numeric rating value %p as a rating', (vote, expected) => {
    expect(
      buildAllDropsPushNotificationTitle({
        actorHandle: 'userA',
        vote,
        context: waveContext
      })
    ).toBe(expected);
  });

  it.each([null, undefined, 'not-a-number', '', '  ', false])(
    'formats non-rating value %p as a message',
    (vote) => {
      expect(
        buildAllDropsPushNotificationTitle({
          actorHandle: 'userA',
          vote,
          context: waveContext
        })
      ).toBe('userA posted · WaveName');
    }
  );
});
