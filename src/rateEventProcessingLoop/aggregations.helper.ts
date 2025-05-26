export function aggregateScoresAndCountsByTarget(
  data: {
    target_profile_id: string;
    old_score: number;
    new_score: number;
  }[]
): Record<string, { score: number; rater_count: number }> {
  return data.reduce(
    (acc, event) => {
      const currentScore = acc[event.target_profile_id]?.score ?? 0;
      const currentRaterCount = acc[event.target_profile_id]?.rater_count ?? 0;
      let raterCountChange = 0;
      if (event.old_score === 0 && event.new_score !== 0) {
        raterCountChange = 1;
      } else if (event.old_score !== 0 && event.new_score === 0) {
        raterCountChange = -1;
      }
      const scoreChange = event.new_score - event.old_score;
      acc[event.target_profile_id] = {
        score: currentScore + scoreChange,
        rater_count: currentRaterCount + raterCountChange
      };
      return acc;
    },
    {} as Record<string, { score: number; rater_count: number }>
  );
}
