export interface ProfileRepRatedEventData {
  rater_profile_id: string;
  target_profile_id: string;
  category: string;
  old_score: number;
  new_score: number;
}
