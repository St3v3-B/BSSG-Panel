CREATE TYPE "public"."backup_status" AS ENUM('pending', 'running', 'completed', 'failed', 'restoring');--> statement-breakpoint
CREATE TYPE "public"."disk_quota_mode" AS ENUM('soft', 'xfs');--> statement-breakpoint
CREATE TYPE "public"."dns_status" AS ENUM('unchecked', 'missing', 'wrong_ip', 'cloudflare_proxy', 'ok');--> statement-breakpoint
CREATE TYPE "public"."schedule_action" AS ENUM('restart', 'command', 'backup');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('installing', 'install_failed', 'offline', 'starting', 'online', 'stopping', 'disk_exceeded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."server_type" AS ENUM('game', 'web');--> statement-breakpoint
CREATE TYPE "public"."ssl_status" AS ENUM('pending', 'dns_wrong', 'issuing', 'active', 'failed');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "activity_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" integer,
	"server_id" integer,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_discord_ids" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"added_by" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"node_id" integer NOT NULL,
	"ip" text NOT NULL,
	"port" integer NOT NULL,
	"server_id" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "allocations_port_range" CHECK ("allocations"."port" between 1 and 65535)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "backups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"s3_target_id" integer,
	"name" text NOT NULL,
	"size_bytes" bigint,
	"s3_key" text NOT NULL,
	"sha256" text,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"includes_databases" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "database_hosts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "database_hosts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 3306 NOT NULL,
	"admin_user" text NOT NULL,
	"admin_password_enc" text NOT NULL,
	"node_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "databases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "databases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"host_id" integer NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_providers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dns_providers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" text DEFAULT 'cloudflare' NOT NULL,
	"name" text NOT NULL,
	"api_token_enc" text NOT NULL,
	"zones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "domains_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"hostname" text NOT NULL,
	"target_port" integer,
	"redirect_to" text,
	"dns_provider_id" integer,
	"wildcard" boolean DEFAULT false NOT NULL,
	"ssl_status" "ssl_status" DEFAULT 'pending' NOT NULL,
	"dns_status" "dns_status" DEFAULT 'unchecked' NOT NULL,
	"last_check" jsonb,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nodes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"fqdn" text NOT NULL,
	"daemon_port" integer DEFAULT 8080 NOT NULL,
	"sftp_port" integer DEFAULT 2022 NOT NULL,
	"token_hash" text NOT NULL,
	"max_ram_mb" integer DEFAULT 0 NOT NULL,
	"max_disk_mb" integer DEFAULT 0 NOT NULL,
	"s3_target_id" integer,
	"disk_quota_mode" "disk_quota_mode",
	"is_local" boolean DEFAULT false NOT NULL,
	"daemon_version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_name_unique" UNIQUE("name"),
	CONSTRAINT "nodes_fqdn_unique" UNIQUE("fqdn"),
	CONSTRAINT "nodes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "s3_targets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "s3_targets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"access_key_enc" text NOT NULL,
	"secret_key_enc" text NOT NULL,
	"path_style" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"action" "schedule_action" NOT NULL,
	"payload" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_variables" (
	"server_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "server_variables_server_id_key_pk" PRIMARY KEY("server_id","key")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "servers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" integer NOT NULL,
	"node_id" integer NOT NULL,
	"template_id" integer NOT NULL,
	"type" "server_type" NOT NULL,
	"cpu_pct" integer NOT NULL,
	"ram_mb" integer NOT NULL,
	"swap_mb" integer DEFAULT 0 NOT NULL,
	"disk_mb" integer NOT NULL,
	"status" "server_status" DEFAULT 'installing' NOT NULL,
	"installed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"totp_verified" boolean DEFAULT false NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sftp_credentials" (
	"user_id" integer NOT NULL,
	"server_id" integer NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sftp_credentials_user_id_server_id_pk" PRIMARY KEY("user_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "subusers" (
	"server_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subusers_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "server_type" NOT NULL,
	"image" text NOT NULL,
	"startup" text NOT NULL,
	"stop" jsonb NOT NULL,
	"ready_pattern" text NOT NULL,
	"http_port" integer,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"install_image" text NOT NULL,
	"install_script" text NOT NULL,
	"config_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"source_yaml" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"discord_id" text,
	"name" text,
	"avatar_url" text,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"is_emergency" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "users_discord_or_emergency" CHECK ("users"."discord_id" is not null or "users"."is_emergency")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_discord_ids" ADD CONSTRAINT "admin_discord_ids_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_s3_target_id_s3_targets_id_fk" FOREIGN KEY ("s3_target_id") REFERENCES "public"."s3_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_hosts" ADD CONSTRAINT "database_hosts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_host_id_database_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."database_hosts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_dns_provider_id_dns_providers_id_fk" FOREIGN KEY ("dns_provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_s3_target_id_s3_targets_id_fk" FOREIGN KEY ("s3_target_id") REFERENCES "public"."s3_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_variables" ADD CONSTRAINT "server_variables_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_credentials" ADD CONSTRAINT "sftp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_credentials" ADD CONSTRAINT "sftp_credentials_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_user_idx" ON "activity_log" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "activity_server_idx" ON "activity_log" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "activity_action_idx" ON "activity_log" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_node_ip_port" ON "allocations" USING btree ("node_id","ip","port");--> statement-breakpoint
CREATE INDEX "backups_server_idx" ON "backups" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "databases_host_name" ON "databases" USING btree ("host_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_one_local" ON "nodes" USING btree ("is_local") WHERE "nodes"."is_local";--> statement-breakpoint
CREATE INDEX "servers_owner_idx" ON "servers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "servers_node_idx" ON "servers" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_emergency" ON "users" USING btree ("is_emergency") WHERE "users"."is_emergency";