import type { VotingCreditsReturnedNotificationData } from '@/notifications/user-notification.types';

export function buildVotingCreditReturnPushNotification(
  data: VotingCreditsReturnedNotificationData
) {
  const amount = new Intl.NumberFormat('en-US').format(data.amount);
  const action =
    data.reason === 'WIN' ? 'won' : 'was deleted by its author from';
  const credits =
    data.amount === 1 ? 'voting credit was' : 'voting credits were';
  return {
    title: 'Voting credits returned',
    body: `Submission “${data.submission_title}” ${action} “${data.competition_title}”. ${amount} ${credits} returned to you.`,
    data: {
      redirect: 'waves',
      wave_id: data.wave_id,
      competition_id: data.competition_id,
      ...(data.reason === 'WIN' ? { competition_entry_id: data.entry_id } : {})
    },
    imageUrl: null
  };
}
