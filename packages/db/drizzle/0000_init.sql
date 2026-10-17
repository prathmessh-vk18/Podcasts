CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_position_chk" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"privacy" text DEFAULT 'private' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_privacy_chk" CHECK ("privacy" in ('private', 'link')),
	CONSTRAINT "collections_name_chk" CHECK (length(name) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "destination_matches" (
	"episode_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"confidence" real NOT NULL,
	"result" jsonb NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destination_matches_episode_id_platform_pk" PRIMARY KEY("episode_id","platform"),
	CONSTRAINT "destination_matches_platform_chk" CHECK ("platform" in ('youtube', 'spotify', 'apple')),
	CONSTRAINT "destination_matches_status_chk" CHECK ("status" in ('native', 'exact', 'strong', 'review', 'none')),
	CONSTRAINT "destination_matches_confidence_chk" CHECK (confidence between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_platform" text NOT NULL,
	"source_episode_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text NOT NULL,
	"show_title" text NOT NULL,
	"show_source_id" text,
	"description" text,
	"published_at" timestamp with time zone,
	"duration_sec" integer,
	"artwork_url" text,
	"feed_item_guid" text,
	"enclosure_url" text,
	"people" text[] DEFAULT '{}'::text[] NOT NULL,
	"topic_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"popularity" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episodes_platform_chk" CHECK ("source_platform" in ('youtube', 'spotify', 'apple')),
	CONSTRAINT "episodes_duration_chk" CHECK (duration_sec is null or duration_sec > 0)
);
--> statement-breakpoint
CREATE TABLE "export_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"episode_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"decision" text,
	"duplicate_of" uuid,
	"state" text NOT NULL,
	"skip_reason" text,
	"match" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"destination_item_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_items_kind_chk" CHECK ("kind" in ('ready', 'review', 'unavailable', 'duplicate')),
	CONSTRAINT "export_items_state_chk" CHECK ("state" in ('pending', 'added', 'failed', 'skipped')),
	CONSTRAINT "export_items_decision_chk" CHECK (decision is null or decision in ('accept', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"collection_id" uuid,
	"destination" text NOT NULL,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"playlist_title" text,
	"playlist_id" text,
	"playlist_url" text,
	"error" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_jobs_destination_chk" CHECK ("destination" in ('youtube', 'spotify', 'apple')),
	CONSTRAINT "export_jobs_status_chk" CHECK ("status" in ('planning', 'needs_review', 'ready', 'running', 'completed', 'partial', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_platform_chk" CHECK ("platform" in ('youtube', 'spotify', 'apple'))
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_platform_chk" CHECK ("platform" in ('youtube', 'spotify', 'apple')),
	CONSTRAINT "provider_accounts_status_chk" CHECK ("status" in ('active', 'needs_reauth'))
);
--> statement-breakpoint
CREATE TABLE "quota_usage" (
	"key" text NOT NULL,
	"day" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quota_usage_key_day_pk" PRIMARY KEY("key","day"),
	CONSTRAINT "quota_usage_used_chk" CHECK (used >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_matches" ADD CONSTRAINT "destination_matches_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_job_id_export_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_unique" ON "collection_items" USING btree ("collection_id","episode_id");--> statement-breakpoint
CREATE INDEX "collection_items_order" ON "collection_items" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "collections_user" ON "collections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "episodes_source" ON "episodes" USING btree ("source_platform","source_episode_id");--> statement-breakpoint
CREATE INDEX "export_items_job" ON "export_items" USING btree ("job_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "export_jobs_idempotency" ON "export_jobs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "export_jobs_status" ON "export_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "oauth_states_expires" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_user_platform" ON "provider_accounts" USING btree ("user_id","platform");