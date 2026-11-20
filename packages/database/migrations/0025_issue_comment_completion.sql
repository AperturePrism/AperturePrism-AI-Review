ALTER TABLE "external_publications" ADD COLUMN "issue_comment_pending_attempt_id" uuid;
--> statement-breakpoint
CREATE INDEX "external_publications_pending_issue_comment_idx" ON "external_publications" ("updated_at", "id") WHERE "channel" = 'github_issue_comment' AND "issue_comment_pending_attempt_id" IS NOT NULL;
