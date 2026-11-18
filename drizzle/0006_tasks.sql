CREATE TYPE "public"."task_status" AS ENUM('not_started', 'in_progress', 'done');--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"project_id" integer NOT NULL,
	"number" integer NOT NULL,
	"code" text GENERATED ALWAYS AS ('PRJ-' || lpad(project_id::text, greatest(4, length(project_id::text)), '0') || '-T-' || lpad(number::text, greatest(4, length(number::text)), '0')) STORED NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "task_status" DEFAULT 'not_started' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tasks_project_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "tasks_dates_check" CHECK ("tasks"."end_date" >= "tasks"."start_date")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "next_task_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;