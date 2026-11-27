ALTER TABLE "servers" ADD COLUMN "auto_restart" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "auto_restart_max" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "discord_webhook_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_webhook_enc" text;