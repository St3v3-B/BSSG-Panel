CREATE TABLE "app_installs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_installs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"user_id" integer,
	"app_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error" text,
	"result_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_installs" ADD CONSTRAINT "app_installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_installs_server" ON "app_installs" USING btree ("server_id");