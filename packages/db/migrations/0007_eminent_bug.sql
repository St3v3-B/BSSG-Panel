CREATE TABLE "server_content" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "server_content_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"source" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"version_id" text NOT NULL,
	"version_number" text NOT NULL,
	"filename" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_content" ADD CONSTRAINT "server_content_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_content_project" ON "server_content" USING btree ("server_id","source","project_id");--> statement-breakpoint
CREATE INDEX "server_content_server_idx" ON "server_content" USING btree ("server_id");