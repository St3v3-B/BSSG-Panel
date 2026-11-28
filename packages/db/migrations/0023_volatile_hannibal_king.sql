CREATE TABLE "import_items" (
	"session_id" integer NOT NULL,
	"source_server_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"method" text,
	"server_id" integer,
	"new_uuid" uuid,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "import_items_session_id_source_server_id_pk" PRIMARY KEY("session_id","source_server_id")
);
--> statement-breakpoint
CREATE TABLE "import_sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"api_key_enc" text,
	"client_key_enc" text,
	"sftp" jsonb,
	"snapshot" jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_by" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_evacuation_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "node_evacuation_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"evacuation_id" integer NOT NULL,
	"server_id" integer,
	"server_uuid" uuid NOT NULL,
	"server_name" text NOT NULL,
	"target_node_id" integer,
	"auto" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"result" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "node_evacuations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "node_evacuations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"node_id" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "maintenance" jsonb;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_session_id_import_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."import_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sessions" ADD CONSTRAINT "import_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_evacuation_items" ADD CONSTRAINT "node_evacuation_items_evacuation_id_node_evacuations_id_fk" FOREIGN KEY ("evacuation_id") REFERENCES "public"."node_evacuations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_evacuation_items" ADD CONSTRAINT "node_evacuation_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_evacuation_items" ADD CONSTRAINT "node_evacuation_items_target_node_id_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_evacuations" ADD CONSTRAINT "node_evacuations_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_evacuations" ADD CONSTRAINT "node_evacuations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_evacuation_items_evac_idx" ON "node_evacuation_items" USING btree ("evacuation_id");--> statement-breakpoint
CREATE INDEX "node_evacuations_node_idx" ON "node_evacuations" USING btree ("node_id");