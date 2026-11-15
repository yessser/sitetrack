ALTER TABLE "project_members" ADD COLUMN "admin_since" timestamp with time zone;--> statement-breakpoint
UPDATE "project_members" SET "admin_since" = "joined_at" WHERE "is_admin";--> statement-breakpoint
ALTER TABLE "project_members" DROP COLUMN "is_admin";
