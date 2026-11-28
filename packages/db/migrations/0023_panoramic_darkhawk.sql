ALTER TABLE "nodes" ADD COLUMN "npm_settings" jsonb;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "npm_password_enc" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "npm_cloudflare_token_enc" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "npm_status" jsonb;