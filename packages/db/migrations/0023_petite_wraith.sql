CREATE TABLE "server_alarm_state" (
	"server_id" integer NOT NULL,
	"metric" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"since" timestamp with time zone,
	"value" real,
	"threshold" integer,
	"last_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_alarm_state_server_id_metric_pk" PRIMARY KEY("server_id","metric")
);
--> statement-breakpoint
CREATE TABLE "server_alarms" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cpu_pct" integer,
	"ram_pct" integer,
	"duration_minutes" integer DEFAULT 5 NOT NULL,
	"disk_pct" integer,
	"notify_offline" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_clones" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "server_clones_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source_server_id" integer,
	"target_server_id" integer,
	"source_uuid" uuid NOT NULL,
	"target_uuid" uuid NOT NULL,
	"source_name" text NOT NULL,
	"target_name" text NOT NULL,
	"user_id" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"bytes_copied" bigint DEFAULT 0 NOT NULL,
	"bytes_total" bigint,
	"databases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "server_alarm_state" ADD CONSTRAINT "server_alarm_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_alarms" ADD CONSTRAINT "server_alarms_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_clones" ADD CONSTRAINT "server_clones_source_server_id_servers_id_fk" FOREIGN KEY ("source_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_clones" ADD CONSTRAINT "server_clones_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_clones" ADD CONSTRAINT "server_clones_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_alarm_state_active_idx" ON "server_alarm_state" USING btree ("active");--> statement-breakpoint
CREATE INDEX "server_clones_source_idx" ON "server_clones" USING btree ("source_server_id");--> statement-breakpoint
CREATE INDEX "server_clones_target_idx" ON "server_clones" USING btree ("target_server_id");