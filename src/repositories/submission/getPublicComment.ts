import { publicCommentFromRow } from "./mapper";
import type { PublicSubmissionComment } from "./types";

export interface PublicCommentContext {
  targetId: string;
  path: PublicSubmissionComment[];
}

export async function getPublicCommentContextById(
  db: D1Database,
  payload: { id: string; markerId: string }
): Promise<PublicCommentContext | null> {
  const result = await db
    .prepare(
      `WITH RECURSIVE comment_path AS (
         SELECT s.*, 0 AS ancestor_distance
         FROM ugc_submissions s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
           AND s.status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT parent.*, child.ancestor_distance + 1
         FROM comment_path child
         INNER JOIN ugc_submissions parent ON parent.id = child.parent_id
         WHERE parent.poi_id = ?2
           AND parent.kind = 'comment'
       )
       SELECT
         path.*,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = path.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM ugc_submission_flags
          WHERE submission_id = path.id AND active = 1) AS flag_count,
         (SELECT COUNT(*)
          FROM ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent
          WHERE child.parent_id = path.id
            AND child.kind = 'comment'
            AND child.status IN ('active', 'flagged', 'remove_request')) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
       FROM comment_path path
       LEFT JOIN users u ON u.uid = path.user_id
       WHERE path.status IN ('active', 'flagged', 'remove_request')
       ORDER BY path.ancestor_distance DESC`
    )
    .bind(payload.id, payload.markerId)
    .all<Record<string, unknown>>();

  const path = (result.results ?? []).map((row) => publicCommentFromRow(row));
  return path.length > 0 ? { targetId: payload.id, path } : null;
}
