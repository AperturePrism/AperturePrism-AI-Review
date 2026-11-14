CREATE TABLE "pull_request_auto_merges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "analysis_tasks"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "installation_id" text NOT NULL,
  "repository_full_name" text NOT NULL,
  "pull_number" integer NOT NULL CONSTRAINT "pull_request_auto_merges_pull_positive" CHECK ("pull_number" > 0),
  "head_sha" text NOT NULL,
  "method" text DEFAULT 'squash' NOT NULL CONSTRAINT "pull_request_auto_merges_method_valid" CHECK ("method" IN ('merge', 'squash', 'rebase')),
  "status" text DEFAULT 'pending' NOT NULL CONSTRAINT "pull_request_auto_merges_status_valid" CHECK ("status" IN ('pending', 'waiting', 'blocked', 'merged', 'canceled')),
  "reason" text DEFAULT 'awaiting_checks' NOT NULL,
  "message" text,
  "merge_commit_sha" text,
  "attempts" integer DEFAULT 0 NOT NULL CONSTRAINT "pull_request_auto_merges_attempts_nonnegative" CHECK ("attempts" >= 0),
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_auto_merges_task_unique" ON "pull_request_auto_merges" ("task_id");
--> statement-breakpoint
CREATE INDEX "pull_request_auto_merges_pending_idx" ON "pull_request_auto_merges" ("next_attempt_at", "id")
WHERE "status" IN ('pending', 'waiting', 'blocked');
--> statement-breakpoint
CREATE INDEX "pull_request_auto_merges_repository_idx" ON "pull_request_auto_merges" ("repository_id", "created_at");
