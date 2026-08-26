-- AlterTable
-- Per-plan colour overrides, completing the set that widgetDesign and
-- widgetBenefitChips started. Empty string means "inherit the AppSettings
-- value" — the same convention widgetDesign already uses.
--
-- widgetBorderRadius is NULLable rather than using a sentinel: 0 is a valid
-- radius, so a numeric column has no spare value to mean "unset".
ALTER TABLE `SellingPlanGroup`
  ADD COLUMN `widgetPrimaryColor` VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `widgetBadgeColor`   VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN `widgetBorderRadius` INTEGER      NULL;
