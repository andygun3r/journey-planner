ALTER TABLE "user" ADD COLUMN "push_subscription" jsonb;--> statement-breakpoint
ALTER TABLE "commute" DROP CONSTRAINT "commute_device_id_device_id_fk";--> statement-breakpoint
ALTER TABLE "commute_holiday" DROP CONSTRAINT "commute_holiday_device_id_device_id_fk";--> statement-breakpoint
ALTER TABLE "favourite_journey" DROP CONSTRAINT "favourite_journey_device_id_device_id_fk";--> statement-breakpoint
DROP INDEX "commute_device_idx";--> statement-breakpoint
DROP INDEX "holiday_device_idx";--> statement-breakpoint
DROP INDEX "favourite_device_idx";--> statement-breakpoint
ALTER TABLE "commute" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "commute_holiday" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "favourite_journey" ADD COLUMN "user_id" text;--> statement-breakpoint
DELETE FROM "commute";--> statement-breakpoint
DELETE FROM "commute_holiday";--> statement-breakpoint
DELETE FROM "favourite_journey";--> statement-breakpoint
ALTER TABLE "commute" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commute_holiday" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "favourite_journey" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commute" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "commute_holiday" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "favourite_journey" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "commute" ADD CONSTRAINT "commute_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute_holiday" ADD CONSTRAINT "commute_holiday_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_journey" ADD CONSTRAINT "favourite_journey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commute_user_idx" ON "commute" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "holiday_user_idx" ON "commute_holiday" USING btree ("user_id","start_date");--> statement-breakpoint
CREATE INDEX "favourite_user_idx" ON "favourite_journey" USING btree ("user_id");--> statement-breakpoint
DROP TABLE "device";
