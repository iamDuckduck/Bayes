import { publicCommentFromRow } from "./mapper";
import type { PublicSubmissionComment } from "./types";

export interface PublicCommentContext {
  targetId: string;
  path: PublicSubmissionComment[];
  replies: PublicSubmissionComment[];
  repliesTruncated: boolean;
}

const REPLY_CONTEXT_LIMIT = 10;

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
  if (path.length === 0) return null;

  const replyResult = await db
    .prepare(
      `WITH RECURSIVE reply_context AS (
         SELECT s.*, 0 AS relative_depth
         FROM ugc_submissions s
         WHERE s.id = ?1
           AND s.poi_id = ?2
           AND s.kind = 'comment'
           AND s.status IN ('active', 'flagged', 'remove_request')
         UNION ALL
         SELECT child.*, parent.relative_depth + 1
         FROM reply_context parent
         INNER JOIN ugc_submissions child ON child.parent_id = parent.id
         WHERE child.poi_id = ?2
           AND child.kind = 'comment'
       ),
       selected_replies AS MATERIALIZED (
         SELECT *
         FROM reply_context
         WHERE relative_depth > 0
           AND status IN ('active', 'flagged', 'remove_request')
         ORDER BY relative_depth ASC, created_at ASC, id ASC
         LIMIT ?3
       )
       SELECT
         reply.*,
         COALESCE((
           SELECT SUM(value)
           FROM ugc_submission_votes
           WHERE submission_id = reply.id AND active = 1
         ), 0) AS score,
         (SELECT COUNT(*)
          FROM ugc_submission_flags
          WHERE submission_id = reply.id AND active = 1) AS flag_count,
         (SELECT COUNT(*)
          FROM ugc_submissions child INDEXED BY idx_ugc_visible_comment_parent
          WHERE child.parent_id = reply.id
            AND child.kind = 'comment'
            AND child.status IN ('active', 'flagged', 'remove_request')) AS reply_count,
         u.uid AS submitter_uid,
         u.uid_number AS user_uid_number,
         u.uid_suffix AS user_uid_suffix,
         u.role AS user_role,
         u.karma AS user_karma,
         u.nickname AS user_nickname,
         u.avt AS user_avt
       FROM selected_replies reply
       LEFT JOIN users u ON u.uid = reply.user_id
       ORDER BY reply.relative_depth ASC, reply.created_at ASC, reply.id ASC`
    )
    .bind(payload.id, payload.markerId, REPLY_CONTEXT_LIMIT + 1)
    .all<Record<string, unknown>>();

  const replyCandidates = (replyResult.results ?? []).map((row) => publicCommentFromRow(row));
  return {
    targetId: payload.id,
    path,
    replies: replyCandidates.slice(0, REPLY_CONTEXT_LIMIT),
    repliesTruncated: replyCandidates.length > REPLY_CONTEXT_LIMIT
  };
}
