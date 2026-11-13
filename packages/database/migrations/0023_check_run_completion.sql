ALTER TABLE "external_publications" ADD COLUMN "check_run_completed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "external_publications_pending_check_idx"
ON "external_publications" ("updated_at", "id")
WHERE "channel" = 'check_run' AND "check_run_completed_at" IS NULL;
