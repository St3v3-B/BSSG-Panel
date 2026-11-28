CREATE TABLE "player_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"player_uuid" uuid,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "server_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "server_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"server_id" integer NOT NULL,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_sessions" ADD CONSTRAINT "player_sessions_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_events" ADD CONSTRAINT "server_events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "player_sessions_unique" ON "player_sessions" USING btree ("server_id","name","joined_at");--> statement-breakpoint
CREATE INDEX "player_sessions_server_idx" ON "player_sessions" USING btree ("server_id","joined_at");--> statement-breakpoint
CREATE INDEX "player_sessions_open_idx" ON "player_sessions" USING btree ("server_id") WHERE "player_sessions"."left_at" is null;--> statement-breakpoint
CREATE INDEX "player_sessions_left_idx" ON "player_sessions" USING btree ("left_at");--> statement-breakpoint
CREATE INDEX "server_events_server_idx" ON "server_events" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "server_events_at_idx" ON "server_events" USING btree ("at");