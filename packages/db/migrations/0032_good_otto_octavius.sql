CREATE TABLE "site_publishes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "site_publishes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"staging_server_id" integer,
	"production_server_id" integer,
	"staging_uuid" uuid NOT NULL,
	"production_uuid" uuid NOT NULL,
	"staging_name" text NOT NULL,
	"production_name" text NOT NULL,
	"user_id" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"backup_id" integer,
	"databases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"temp_databases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kept" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url_rewrite" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restored" boolean,
	"error_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_publishes" ADD CONSTRAINT "site_publishes_staging_server_id_servers_id_fk" FOREIGN KEY ("staging_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publishes" ADD CONSTRAINT "site_publishes_production_server_id_servers_id_fk" FOREIGN KEY ("production_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publishes" ADD CONSTRAINT "site_publishes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_publishes" ADD CONSTRAINT "site_publishes_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_publishes_staging_idx" ON "site_publishes" USING btree ("staging_server_id");--> statement-breakpoint
CREATE INDEX "site_publishes_production_idx" ON "site_publishes" USING btree ("production_server_id");