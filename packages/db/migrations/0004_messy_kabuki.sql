ALTER TABLE "domains" ADD COLUMN "protocol" text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "domains_allowed" boolean DEFAULT false NOT NULL;