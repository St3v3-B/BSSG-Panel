CREATE TABLE "server_stats" (
	"server_id" integer NOT NULL,
	"resolution" integer NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"samples" integer NOT NULL,
	"cpu_pct" real NOT NULL,
	"cpu_max_pct" real NOT NULL,
	"memory_bytes" bigint NOT NULL,
	"memory_max_bytes" bigint NOT NULL,
	"disk_bytes" bigint NOT NULL,
	"rx_bytes_per_sec" real,
	"tx_bytes_per_sec" real,
	CONSTRAINT "server_stats_server_id_resolution_bucket_pk" PRIMARY KEY("server_id","resolution","bucket")
);
--> statement-breakpoint
ALTER TABLE "server_stats" ADD CONSTRAINT "server_stats_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_stats_retention_idx" ON "server_stats" USING btree ("resolution","bucket");