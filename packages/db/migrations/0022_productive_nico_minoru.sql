ALTER TABLE "nodes" ADD COLUMN "http_relay_node_id" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "relay_secret_enc" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "relay_status" jsonb;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_http_relay_node_id_nodes_id_fk" FOREIGN KEY ("http_relay_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;