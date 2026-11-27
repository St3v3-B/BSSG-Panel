CREATE TABLE "network_members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "network_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"proxy_server_id" integer NOT NULL,
	"backend_server_id" integer NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "network_members_backend_server_id_unique" UNIQUE("backend_server_id")
);
--> statement-breakpoint
ALTER TABLE "network_members" ADD CONSTRAINT "network_members_proxy_server_id_servers_id_fk" FOREIGN KEY ("proxy_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_members" ADD CONSTRAINT "network_members_backend_server_id_servers_id_fk" FOREIGN KEY ("backend_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "network_members_proxy_name" ON "network_members" USING btree ("proxy_server_id","name");--> statement-breakpoint
CREATE INDEX "network_members_proxy_idx" ON "network_members" USING btree ("proxy_server_id");