CREATE TABLE "network_forced_hosts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "network_forced_hosts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"proxy_server_id" integer NOT NULL,
	"hostname" text NOT NULL,
	"backend_server_id" integer NOT NULL,
	CONSTRAINT "network_forced_hosts_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
ALTER TABLE "network_forced_hosts" ADD CONSTRAINT "network_forced_hosts_proxy_server_id_servers_id_fk" FOREIGN KEY ("proxy_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_forced_hosts" ADD CONSTRAINT "network_forced_hosts_backend_server_id_servers_id_fk" FOREIGN KEY ("backend_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_forced_hosts_proxy_idx" ON "network_forced_hosts" USING btree ("proxy_server_id");