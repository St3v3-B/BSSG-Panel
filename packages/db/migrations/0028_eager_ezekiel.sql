CREATE TABLE "server_backup_settings" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"default_kind" text DEFAULT 'full' NOT NULL,
	"keep_last" integer DEFAULT 10 NOT NULL,
	"keep_daily" integer DEFAULT 7 NOT NULL,
	"keep_weekly" integer DEFAULT 4 NOT NULL,
	"restic_password_enc" text,
	"restic_s3_target_id" integer,
	"last_prune_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "kind" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "added_bytes" bigint;--> statement-breakpoint
ALTER TABLE "server_backup_settings" ADD CONSTRAINT "server_backup_settings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_backup_settings" ADD CONSTRAINT "server_backup_settings_restic_s3_target_id_s3_targets_id_fk" FOREIGN KEY ("restic_s3_target_id") REFERENCES "public"."s3_targets"("id") ON DELETE set null ON UPDATE no action;