ALTER TABLE "api_keys" ADD COLUMN "server_ids" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "terminal_allowed" boolean DEFAULT true NOT NULL;