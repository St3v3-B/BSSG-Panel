CREATE INDEX "allocations_server_idx" ON "allocations" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "databases_server_idx" ON "databases" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "domains_server_idx" ON "domains" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "servers_status_idx" ON "servers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subusers_user_idx" ON "subusers" USING btree ("user_id");