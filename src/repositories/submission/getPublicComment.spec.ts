import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteD1 } from "../../test/sqliteD1";
import { getPublicCommentContextById } from "./getPublicComment";

let database: SqliteD1;
let db: D1Database;

beforeEach(() => {
  database = new SqliteD1();
  db = database.db;
  database.sqlite.exec(`
    CREATE TABLE users (
      uid TEXT PRIMARY KEY,
      uid_number INTEGER,
      uid_suffix TEXT,
      role TEXT,
      karma INTEGER,
      nickname TEXT,
      avt INTEGER
    );
    INSERT INTO users VALUES
      ('root-author', 1, 'AA', 'n', 3, 'Root author', 1),
      ('reply-author', 2, 'BB', 'n', 5, 'Reply author', 2);

    CREATE TABLE ugc_submissions (
      id TEXT PRIMARY KEY,
      poi_id TEXT NOT NULL,
      poi_hash TEXT NOT NULL,
      poi_type TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT,
      file_path TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_id TEXT,
      comment_depth INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_ugc_visible_comment_parent
      ON ugc_submissions(parent_id, created_at, id)
      WHERE kind = 'comment'
        AND status IN ('active', 'flagged', 'remove_request');

    CREATE TABLE ugc_submission_votes (
      submission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      value INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (submission_id, user_id)
    );
    CREATE TABLE ugc_submission_flags (
      submission_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (submission_id, user_id)
    );
  `);
});

afterEach(() => database.sqlite.close());

function insertComment(payload: {
  id: string;
  parentId?: string | null;
  depth?: number;
  markerId?: string;
  kind?: "comment" | "image";
  status?: string;
  content?: string;
  userId?: string;
  createdAt?: string;
}) {
  database.sqlite.prepare(`
    INSERT INTO ugc_submissions (
      id, poi_id, poi_hash, poi_type, snapshot_id, user_id, content,
      file_path, kind, status, parent_id, comment_depth, created_at, updated_at
    ) VALUES (?, ?, 'hash', 'poi', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.id,
    payload.markerId ?? "marker-1",
    `snapshot-${payload.id}`,
    payload.userId ?? "reply-author",
    payload.content ?? `Content ${payload.id}`,
    payload.kind ?? "comment",
    payload.status ?? "active",
    payload.parentId ?? null,
    payload.depth ?? 0,
    payload.createdAt ?? "2026-09-10T00:00:00.000Z",
    payload.createdAt ?? "2026-09-10T00:00:00.000Z"
  );
}

describe("getPublicCommentContextById", () => {
  it("returns the public ancestor path from root to target", async () => {
    insertComment({
      id: "root",
      userId: "root-author",
      content: "Root context",
      createdAt: "2026-09-10T00:00:00.000Z"
    });
    insertComment({
      id: "parent",
      parentId: "root",
      depth: 1,
      status: "flagged",
      content: "Parent context",
      createdAt: "2026-09-10T00:01:00.000Z"
    });
    insertComment({
      id: "target",
      parentId: "parent",
      depth: 2,
      status: "remove_request",
      content: "Target context",
      createdAt: "2026-09-10T00:02:00.000Z"
    });
    database.sqlite.exec(`
      INSERT INTO ugc_submission_votes VALUES
        ('root', 'voter-1', 1, 1),
        ('root', 'voter-2', -1, 1),
        ('target', 'voter-1', 1, 1);
    `);

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.targetId).toBe("target");
    expect(context?.path.map((comment) => comment.id)).toEqual(["root", "parent", "target"]);
    expect(context?.path[0]).toMatchObject({
      content: "Root context",
      author: { nickname: "Root author", publicUid: "1AA", avatar: 1, karma: 3 },
      score: 0,
      replyCount: 1
    });
    expect(context?.path[2]).toMatchObject({
      parentId: "parent",
      depth: 2,
      content: "Target context",
      status: "remove_request",
      score: 1
    });
  });

  it("omits a non-public ancestor without exposing its content", async () => {
    insertComment({ id: "root", userId: "root-author", content: "Public root" });
    insertComment({
      id: "hidden-parent",
      parentId: "root",
      depth: 1,
      status: "stale",
      content: "Private removed content"
    });
    insertComment({
      id: "target",
      parentId: "hidden-parent",
      depth: 2,
      content: "Public target"
    });

    const context = await getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-1"
    });

    expect(context?.path.map((comment) => comment.id)).toEqual(["root", "target"]);
    expect(JSON.stringify(context)).not.toContain("Private removed content");
  });

  it.each(["pending_openai", "pending_audit", "stale"])(
    "does not return a target with non-public status %s",
    async (status) => {
      insertComment({ id: "target", status });

      await expect(getPublicCommentContextById(db, {
        id: "target",
        markerId: "marker-1"
      })).resolves.toBeNull();
    }
  );

  it("requires the exact target ID, marker, and comment kind", async () => {
    insertComment({ id: "target" });
    insertComment({ id: "image", kind: "image" });

    await expect(getPublicCommentContextById(db, {
      id: "missing",
      markerId: "marker-1"
    })).resolves.toBeNull();
    await expect(getPublicCommentContextById(db, {
      id: "target",
      markerId: "marker-2"
    })).resolves.toBeNull();
    await expect(getPublicCommentContextById(db, {
      id: "image",
      markerId: "marker-1"
    })).resolves.toBeNull();
  });
});
