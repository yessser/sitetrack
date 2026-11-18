ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_unique" UNIQUE("project_id","id");--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"project_id" integer NOT NULL,
	"task_id" integer NOT NULL,
	"depends_on_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_project_id_task_id_depends_on_id_pk" PRIMARY KEY("project_id","task_id","depends_on_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_id")
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_task_id_tasks_project_id_id_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_depends_on_id_tasks_project_id_id_fk" FOREIGN KEY ("project_id","depends_on_id") REFERENCES "public"."tasks"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_idx" ON "task_dependencies" USING btree ("project_id","depends_on_id");
