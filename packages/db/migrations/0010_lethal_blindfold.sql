ALTER TYPE "public"."schedule_action" ADD VALUE 'exec';--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "last_output" text;