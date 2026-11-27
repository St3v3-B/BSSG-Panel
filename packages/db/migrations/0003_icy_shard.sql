ALTER TABLE "servers" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "suspended_reason" text;