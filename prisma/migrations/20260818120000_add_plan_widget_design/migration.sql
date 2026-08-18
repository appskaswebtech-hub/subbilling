-- AlterTable
-- Per-plan overrides of the shop-wide widget appearance. Empty means "inherit
-- the AppSettings value". A product renders ONE widget, so when several plans
-- are attached the newest plan's design wins.
ALTER TABLE `SellingPlanGroup`
  ADD COLUMN `widgetDesign`       VARCHAR(191)  NOT NULL DEFAULT '',
  ADD COLUMN `widgetBenefitChips` VARCHAR(1000) NOT NULL DEFAULT '';
