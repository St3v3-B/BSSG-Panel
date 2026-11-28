CREATE SCHEMA "mail";
--> statement-breakpoint
CREATE TABLE "mail"."aliases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail"."aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"domain_id" integer NOT NULL,
	"address" text NOT NULL,
	"goto" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "mail"."dkim_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail"."dkim_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"domain_id" integer NOT NULL,
	"selector" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"public_key" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mail"."domains" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail"."domains_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"domain" text NOT NULL,
	"description" text,
	"max_mailboxes" integer DEFAULT 0 NOT NULL,
	"max_quota_mb" integer DEFAULT 0 NOT NULL,
	"dns_status" text DEFAULT 'pending' NOT NULL,
	"dns_checked_at" timestamp with time zone,
	"dns_last_check" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"owner_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "mail"."mailboxes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail"."mailboxes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"domain_id" integer NOT NULL,
	"local_part" text NOT NULL,
	"address" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"quota_mb" integer DEFAULT 1024 NOT NULL,
	"last_login" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "mail"."aliases" ADD CONSTRAINT "aliases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "mail"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."dkim_keys" ADD CONSTRAINT "dkim_keys_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "mail"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."domains" ADD CONSTRAINT "domains_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail"."mailboxes" ADD CONSTRAINT "mailboxes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "mail"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_aliases_domain_idx" ON "mail"."aliases" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "mail_dkim_domain_idx" ON "mail"."dkim_keys" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_mailboxes_domain_local_unique" ON "mail"."mailboxes" USING btree ("domain_id","local_part");--> statement-breakpoint
CREATE VIEW "mail"."v_aliases" AS (select a.address, a.goto from mail.aliases a join mail.domains d on d.id = a.domain_id where a.active and d.active);--> statement-breakpoint
CREATE VIEW "mail"."v_domains" AS (select domain from mail.domains where active);--> statement-breakpoint
CREATE VIEW "mail"."v_mailboxes" AS (select m.address, d.domain, m.local_part, m.password_hash, m.quota_mb, d.domain || '/' || m.local_part || '/' as maildir from mail.mailboxes m join mail.domains d on d.id = m.domain_id where m.active and d.active);--> statement-breakpoint
CREATE VIEW "mail"."v_senders" AS (select m.address as sender, m.address as login from mail.mailboxes m join mail.domains d on d.id = m.domain_id where m.active and d.active union select a.address as sender, mb.address as login from mail.aliases a join mail.domains d on d.id = a.domain_id cross join lateral unnest(string_to_array(a.goto, ',')) as g(target) join mail.mailboxes mb on mb.address = lower(trim(g.target)) and mb.active join mail.domains md on md.id = mb.domain_id and md.active where a.active and d.active and a.address not like '@%');