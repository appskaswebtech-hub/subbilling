-- How long before each billing date a prepaid plan's or bundle's payment link
-- is emailed, in hours. NULL keeps the shop-wide setting
-- (AppSettings.prepaidInvoiceLeadDays), so nothing existing changes.
ALTER TABLE `SellingPlanGroup` ADD COLUMN `prepaidLeadHours` INTEGER NULL;

ALTER TABLE `ProductBundle` ADD COLUMN `prepaidLeadHours` INTEGER NULL;
