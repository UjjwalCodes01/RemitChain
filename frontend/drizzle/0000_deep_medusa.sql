CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_name" text NOT NULL,
	"wallet_address" text,
	"transfer_id" text,
	"metadata" text,
	"created_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_cursor" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_processed_block" bigint DEFAULT 0 NOT NULL,
	"updated_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_attempts" (
	"transfer_id" text PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"locked_at" integer,
	"last_attempt_at" integer,
	"last_attempt_ip" text
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_address" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_address" text NOT NULL,
	"recipient_phone_hash" text,
	"recipient_nickname" text,
	"amount" text NOT NULL,
	"corridor" text NOT NULL,
	"frequency" text NOT NULL,
	"day_of_month" integer,
	"next_run_at" integer NOT NULL,
	"last_run_at" integer,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"tx_hash" text,
	"sender_address" text NOT NULL,
	"recipient_phone_hash" text NOT NULL,
	"recipient_nickname" text,
	"amount" text NOT NULL,
	"corridor" text NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"offramp_status" text DEFAULT 'NONE' NOT NULL,
	"offramp_method" text,
	"offramp_reference" text,
	"sms_status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL,
	"updated_at" integer DEFAULT extract(epoch from now()) * 1000 NOT NULL,
	"claimed_at" integer,
	"expiry" integer
);
--> statement-breakpoint
ALTER TABLE "otp_attempts" ADD CONSTRAINT "otp_attempts_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analytics_event" ON "analytics_events" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "idx_analytics_created" ON "analytics_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_push_endpoint" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_push_user" ON "push_subscriptions" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "idx_schedules_sender" ON "schedules" USING btree ("sender_address");--> statement-breakpoint
CREATE INDEX "idx_schedules_next_run" ON "schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_transfers_sender" ON "transfers" USING btree ("sender_address");--> statement-breakpoint
CREATE INDEX "idx_transfers_status" ON "transfers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_transfers_created" ON "transfers" USING btree ("created_at");