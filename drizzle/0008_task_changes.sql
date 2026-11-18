CREATE TYPE "public"."task_change_op" AS ENUM('create', 'update', 'link', 'unlink', 'remove');--> statement-breakpoint
CREATE TABLE "task_changes" (
	"project_id" integer NOT NULL,
	"version" integer NOT NULL,
	"seq" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"op" "task_change_op" NOT NULL,
	"task_number" integer NOT NULL,
	"depends_on_number" integer,
	"data" jsonb,
	"prev" jsonb,
	CONSTRAINT "task_changes_project_id_version_seq_pk" PRIMARY KEY("project_id","version","seq"),
	CONSTRAINT "task_changes_link_target" CHECK (("task_changes"."op" in ('link', 'unlink')) = ("task_changes"."depends_on_number" is not null))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "graph_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_changes" ADD CONSTRAINT "task_changes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_changes" ADD CONSTRAINT "task_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_changes_created_at_idx" ON "task_changes" USING btree ("created_at");