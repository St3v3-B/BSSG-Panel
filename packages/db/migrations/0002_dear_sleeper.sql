ALTER TYPE "public"."server_status" ADD VALUE 'sleeping' BEFORE 'unknown';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "sleep_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "sleep_idle_minutes" integer DEFAULT 10 NOT NULL;