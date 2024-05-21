update profile_activity_logs p2
    INNER JOIN profile_activity_logs p1 ON p1.created_at = p2.created_at and p2.target_id = p2.target_id and p1.type = 'PROXY_RATING_EDIT' and p2.type = 'RATING_EDIT'
SET p2.proxy_id = p1.profile_id;