CREATE TABLE "catalog_shows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text DEFAULT 'apple' NOT NULL,
	"source_show_id" text NOT NULL,
	"title" text NOT NULL,
	"topic" text NOT NULL,
	"artwork_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_shows_platform_chk" CHECK ("platform" in ('youtube', 'spotify', 'apple'))
);
--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_shows_source" ON "catalog_shows" USING btree ("platform","source_show_id");--> statement-breakpoint
CREATE INDEX "catalog_shows_topic" ON "catalog_shows" USING btree ("topic");--> statement-breakpoint
CREATE INDEX "episodes_topic_tags" ON "episodes" USING gin ("topic_tags");--> statement-breakpoint
CREATE INDEX "episodes_published" ON "episodes" USING btree ("published_at");