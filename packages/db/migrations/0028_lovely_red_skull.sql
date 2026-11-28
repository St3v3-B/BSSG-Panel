ALTER TABLE "users" ADD COLUMN "login_username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_set_by_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_login_username_unique" UNIQUE("login_username");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_login_username_not_emergency" CHECK ("users"."login_username" is null or not "users"."is_emergency");