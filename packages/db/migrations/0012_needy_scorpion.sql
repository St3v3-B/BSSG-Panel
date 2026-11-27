ALTER TABLE "servers" ADD COLUMN "image_update_policy" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "image_update_available" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "image_reinstall_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "image_checked_at" timestamp with time zone;