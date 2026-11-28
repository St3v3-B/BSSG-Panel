CREATE TABLE "deploy_configs" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"token_enc" text,
	"token_username" text,
	"ssh_private_key_enc" text,
	"ssh_public_key" text,
	"known_hosts" text,
	"ssh_host_for" text,
	"ssh_host_keys" jsonb,
	"ssh_host_trust" text,
	"target_dir" text NOT NULL,
	"source_dir" text DEFAULT '/' NOT NULL,
	"build_command" text,
	"build_image" text DEFAULT 'site' NOT NULL,
	"shared_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"restart_after" boolean DEFAULT false NOT NULL,
	"auto_deploy" boolean DEFAULT true NOT NULL,
	"webhook_id" text NOT NULL,
	"webhook_secret_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deploys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"user_id" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text,
	"commit_author" text,
	"commit_message" text,
	"commit_date" timestamp with time zone,
	"error" text,
	"log" text[] DEFAULT '{}'::text[] NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deploy_configs" ADD CONSTRAINT "deploy_configs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deploy_configs_webhook_id" ON "deploy_configs" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "deploys_server_idx" ON "deploys" USING btree ("server_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "deploys_one_running" ON "deploys" USING btree ("server_id") WHERE status = 'running';