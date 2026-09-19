ALTER TABLE "app_user" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" DROP COLUMN "password_hash";