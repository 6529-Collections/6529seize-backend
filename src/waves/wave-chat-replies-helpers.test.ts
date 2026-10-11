import fc from 'fast-check';
import {
  canReplyInWaveChat,
  isCollapsedWaveReply,
  isWaveChatGroupMember,
  isWaveMainFeedWithoutReplies
} from './wave-chat-replies.helpers';

describe('wave chat replies helpers', () => {
  describe('canReplyInWaveChat', () => {
    it('lets chat group members reply when replies are not open', () => {
      expect(
        canReplyInWaveChat({
          wave: {
            chat_enabled: true,
            chat_group_id: 'chat-group',
            chat_replies_open: false
          },
          groupIdsUserIsEligibleFor: ['chat-group']
        })
      ).toBe(true);
    });

    it('rejects outsiders when replies are not open', () => {
      expect(
        canReplyInWaveChat({
          wave: {
            chat_enabled: true,
            chat_group_id: 'chat-group',
            chat_replies_open: false
          },
          groupIdsUserIsEligibleFor: ['other-group']
        })
      ).toBe(false);
    });

    it('lets outsiders reply when replies are open', () => {
      expect(
        canReplyInWaveChat({
          wave: {
            chat_enabled: true,
            chat_group_id: 'chat-group',
            chat_replies_open: true
          },
          groupIdsUserIsEligibleFor: []
        })
      ).toBe(true);
    });

    it('never allows replies when chat is disabled', () => {
      fc.assert(
        fc.property(
          fc.option(fc.string(), { nil: null }),
          fc.boolean(),
          fc.array(fc.string()),
          (chatGroupId, repliesOpen, groupIds) =>
            !canReplyInWaveChat({
              wave: {
                chat_enabled: false,
                chat_group_id: chatGroupId,
                chat_replies_open: repliesOpen
              },
              groupIdsUserIsEligibleFor: groupIds
            })
        )
      );
    });

    it('allows replies whenever the user can chat', () => {
      fc.assert(
        fc.property(
          fc.option(fc.string(), { nil: null }),
          fc.boolean(),
          fc.array(fc.string()),
          (chatGroupId, repliesOpen, otherGroupIds) => {
            const groupIdsUserIsEligibleFor =
              chatGroupId === null
                ? otherGroupIds
                : [...otherGroupIds, chatGroupId];
            const wave = {
              chat_enabled: true,
              chat_group_id: chatGroupId,
              chat_replies_open: repliesOpen
            };
            return (
              isWaveChatGroupMember({ wave, groupIdsUserIsEligibleFor }) &&
              canReplyInWaveChat({ wave, groupIdsUserIsEligibleFor })
            );
          }
        )
      );
    });
  });

  describe('isWaveMainFeedWithoutReplies', () => {
    it('drops replies from the main feed of collapsed-reply waves', () => {
      expect(
        isWaveMainFeedWithoutReplies({
          wave: { chat_replies_collapsed: true },
          curationId: null
        })
      ).toBe(true);
    });

    it('keeps replies in curated views and in waves without collapsing', () => {
      expect(
        isWaveMainFeedWithoutReplies({
          wave: { chat_replies_collapsed: true },
          curationId: 'curation-1'
        })
      ).toBe(false);
      expect(
        isWaveMainFeedWithoutReplies({
          wave: { chat_replies_collapsed: false },
          curationId: null
        })
      ).toBe(false);
    });
  });

  describe('isCollapsedWaveReply', () => {
    it('matches only replies in collapsed-reply waves', () => {
      expect(
        isCollapsedWaveReply({
          wave: { chat_replies_collapsed: true },
          replyToDropId: 'drop-1'
        })
      ).toBe(true);
      expect(
        isCollapsedWaveReply({
          wave: { chat_replies_collapsed: true },
          replyToDropId: null
        })
      ).toBe(false);
      expect(
        isCollapsedWaveReply({
          wave: { chat_replies_collapsed: false },
          replyToDropId: 'drop-1'
        })
      ).toBe(false);
    });
  });
});
