CREATE TABLE "user_quotas" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"max_ram_mb" integer NOT NULL,
	"max_disk_mb" integer NOT NULL,
	"max_cpu_pct" integer NOT NULL,
	"max_servers" integer NOT NULL,
	"max_databases" integer NOT NULL,
	"template_ids" jsonb,
	"node_ids" jsonb,
	"max_ports_per_server" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_quotas" ADD CONSTRAINT "user_quotas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;