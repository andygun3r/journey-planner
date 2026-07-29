ALTER TABLE "darwin_train" ADD COLUMN "headcode" text;--> statement-breakpoint
CREATE INDEX "darwin_train_headcode_ssd_idx" ON "darwin_train" USING btree ("headcode","ssd");