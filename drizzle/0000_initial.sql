CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'approver' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"post_id" uuid,
	"actor" text NOT NULL,
	"actor_type" text DEFAULT 'human' NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ig_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ig_user_id" text NOT NULL,
	"username" text NOT NULL,
	"account_type" text,
	"profile_picture_url" text,
	"access_token" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_refresh_error" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_generation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slide_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"url" text NOT NULL,
	"provider" text DEFAULT 'gemini' NOT NULL,
	"model" text,
	"selected" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ig_account_id" uuid,
	"template" text DEFAULT 'symptom_carousel' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text DEFAULT 'Untitled post' NOT NULL,
	"prompt" text,
	"caption" text DEFAULT '' NOT NULL,
	"alt_texts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_report" jsonb,
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_media_id" text,
	"schedule_job_id" text,
	"permalink" text,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ig_account_id" uuid NOT NULL,
	"post_id" uuid,
	"succeeded" text DEFAULT 'false' NOT NULL,
	"media_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slide" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text DEFAULT 'hook' NOT NULL,
	"copy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"photo_prompt" text,
	"photo_url" text,
	"rendered_url" text,
	"width" integer DEFAULT 1080 NOT NULL,
	"height" integer DEFAULT 1350 NOT NULL,
	"bytes" integer,
	"rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"vertical" text DEFAULT 'unspecified' NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"brand_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compliance_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_set" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_tenant" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ig_account" ADD CONSTRAINT "ig_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_generation" ADD CONSTRAINT "photo_generation_slide_id_slide_id_fk" FOREIGN KEY ("slide_id") REFERENCES "public"."slide"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_ig_account_id_ig_account_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_ig_account_id_ig_account_id_fk" FOREIGN KEY ("ig_account_id") REFERENCES "public"."ig_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_attempt" ADD CONSTRAINT "publish_attempt_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slide" ADD CONSTRAINT "slide_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenant" ADD CONSTRAINT "user_tenant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenant" ADD CONSTRAINT "user_tenant_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_post" ON "audit_log" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_tenant" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ig_account_ig_user_id" ON "ig_account" USING btree ("ig_user_id");--> statement-breakpoint
CREATE INDEX "photo_generation_slide" ON "photo_generation" USING btree ("slide_id","created_at");--> statement-breakpoint
CREATE INDEX "post_tenant_created" ON "post" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "post_status" ON "post" USING btree ("status");--> statement-breakpoint
CREATE INDEX "post_scheduled_for" ON "post" USING btree ("scheduled_for");--> statement-breakpoint
CREATE INDEX "publish_attempt_account" ON "publish_attempt" USING btree ("ig_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slide_post_position" ON "slide" USING btree ("post_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tenant_pk" ON "user_tenant" USING btree ("user_id","tenant_id");