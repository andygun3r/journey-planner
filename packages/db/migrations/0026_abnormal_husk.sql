ALTER TABLE "commute" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commute_leg" ADD COLUMN "backup_work_crs" text;--> statement-breakpoint
ALTER TABLE "commute_leg" ADD COLUMN "backup_home_crs" text;--> statement-breakpoint
ALTER TABLE "commute_leg" ADD COLUMN "backup_note" text;