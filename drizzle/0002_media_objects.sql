CREATE TABLE "media_object" (
	"pathname" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"data" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
