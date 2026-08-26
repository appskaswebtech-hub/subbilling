-- AlterTable
-- Reconstructed to match the columns already present in the database: this
-- migration is recorded as applied but its file was lost, leaving an empty
-- directory that made the history unreplayable on a fresh install.
--
-- shopifySellingPlanId is the group's single selling plan. Shopify stamps THAT
-- id on subscription contract lines and exposes it to Liquid as a number, while
-- the GROUP id is only exposed as a hash — so this is the only usable join key
-- between a stored plan and the storefront.
ALTER TABLE `SellingPlanGroup`
  ADD COLUMN `shopifySellingPlanId` VARCHAR(191)  NULL,
  ADD COLUMN `customSchedule`       VARCHAR(1000) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE `Subscription`
  ADD COLUMN `sellingPlanId` VARCHAR(191) NULL,
  ADD COLUMN `scheduleIndex` INTEGER      NOT NULL DEFAULT 0;
