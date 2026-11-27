CREATE TABLE "node_join_codes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "node_join_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"node_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_join_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "supports_domains" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "public_port" integer DEFAULT 443 NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "public_ip" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "join_state" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "join_message" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "join_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "join_options" jsonb;--> statement-breakpoint
ALTER TABLE "node_join_codes" ADD CONSTRAINT "node_join_codes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;