/**
 * Collation of the application's text columns in production (schema default,
 * `@@collation_connection` and `@@default_collation_for_utf8mb4` on MySQL
 * 8.0, verified 2026-11-07). SQL that needs an explicit COLLATE must use this
 * value: a different explicit collation compared with an indexed column turns
 * the comparison into a conversion and stops index use. The test schema uses
 * the same value, and `db-collation.db.test.ts` fails if it drifts.
 */
export const DB_TEXT_COLLATION = 'utf8mb4_0900_ai_ci';
