import { serializeDropMessageForRecipient } from '@/api/ws/ws-listeners-notifier';
import { WsMessageType } from '@/api/ws/ws-message';
import { ApiDrop } from '@/api/generated/models/ApiDrop';

function mentionedWave(
  id: string,
  visibilityGroupId: string | null,
  isDirectMessage = false
) {
  return {
    wave_name_in_content: id,
    wave_id: id,
    wave: {
      id,
      name: `name of ${id}`,
      visibility_group_id: visibilityGroupId,
      is_direct_message: isDirectMessage,
      authenticated_user_eligible_to_vote: true,
      authenticated_user_eligible_to_participate: true,
      authenticated_user_eligible_to_chat: true,
      authenticated_user_admin: true
    }
  };
}

function embeddedDrop(id: string) {
  return {
    id,
    author: { id: 'embedded-author', subscribed_actions: ['DROP_CREATED'] },
    context_profile_context: {
      rating: 5,
      reaction: ':+1:',
      boosted: true,
      bookmarked: true
    },
    viewer_context: { author_blocked: true, drop_hidden: true },
    subscribed_actions: ['DROP_REPLIED'],
    mentioned_waves: [mentionedWave('private-wave', 'group-1')],
    parts: [{ part_id: 1, content: 'embedded', quoted_drop: null }],
    reply_to: null
  };
}

function rootDrop(): ApiDrop {
  return {
    id: 'root',
    serial_no: 1,
    wave: {
      id: 'wave-1',
      visibility_group_id: null,
      authenticated_user_eligible_to_vote: true,
      authenticated_user_admin: true
    },
    author: { id: 'root-author', subscribed_actions: ['DROP_CREATED'] },
    context_profile_context: { rating: 1 },
    viewer_context: { author_blocked: false, drop_hidden: false },
    subscribed_actions: ['DROP_VOTED'],
    mentioned_waves: [
      mentionedWave('public-wave', null),
      mentionedWave('private-wave', 'group-1'),
      mentionedWave('dm-wave', 'dm-group', true)
    ],
    parts: [
      {
        part_id: 1,
        content: 'root',
        quoted_drop: {
          drop_id: 'quoted',
          drop_part_id: 1,
          drop: embeddedDrop('quoted')
        }
      }
    ],
    reply_to: {
      drop_id: 'replied',
      drop_part_id: 1,
      drop: embeddedDrop('replied')
    }
  } as unknown as ApiDrop;
}

function serialize(drop: ApiDrop): any {
  return JSON.parse(
    serializeDropMessageForRecipient(drop, 7, WsMessageType.DROP_UPDATE)
  ).data;
}

describe('serializeDropMessageForRecipient viewer-scoped fields', () => {
  it('keeps the root recipient injection and strips the root request context', () => {
    const payload = serialize(rootDrop());

    expect(payload.wave.credit_left).toBe(7);
    expect(payload.wave.authenticated_user_admin).toBeUndefined();
    expect(payload.author.subscribed_actions).toBeUndefined();
    expect(payload.context_profile_context).toBeUndefined();
    expect(payload.viewer_context).toEqual({
      author_blocked: false,
      drop_hidden: false
    });
  });

  it.each([
    ['quoted', (payload: any) => payload.parts[0].quoted_drop.drop],
    ['replied-to', (payload: any) => payload.reply_to.drop]
  ])('strips viewer-scoped fields from the %s drop', (_label, embeddedOf) => {
    const embedded = embeddedOf(serialize(rootDrop()));

    expect(embedded.context_profile_context).toBeNull();
    expect(embedded.subscribed_actions).toEqual([]);
    expect(embedded.author.subscribed_actions).toEqual([]);
    expect(embedded).not.toHaveProperty('viewer_context');
    expect(embedded.mentioned_waves[0]).toEqual({
      wave_name_in_content: 'private-wave',
      wave_id: 'private-wave'
    });
  });

  it('keeps public mentioned wave details without viewer fields and omits restricted ones', () => {
    const [publicWave, privateWave, dmWave] =
      serialize(rootDrop()).mentioned_waves;

    expect(publicWave.wave).toEqual({
      id: 'public-wave',
      name: 'name of public-wave',
      visibility_group_id: null,
      is_direct_message: false
    });
    expect(privateWave).not.toHaveProperty('wave');
    expect(privateWave.wave_id).toBe('private-wave');
    expect(dmWave).not.toHaveProperty('wave');
  });

  it('does not mutate the input drop', () => {
    const drop = rootDrop();
    const before = JSON.stringify(drop);

    serialize(drop);

    expect(JSON.stringify(drop)).toBe(before);
  });
});
