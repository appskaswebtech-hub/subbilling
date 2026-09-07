-- AlterTable
-- Currency the AppSubscription was created in (from shopBillingPreferences).
-- Plain ADD COLUMN: `IF NOT EXISTS` is a MariaDB extension that MySQL rejects.
-- Existing rows default to USD, which is what every subscription created
-- before this migration was actually priced in.
ALTER TABLE `ShopPlan` ADD COLUMN `billingCurrency` VARCHAR(191) NOT NULL DEFAULT 'USD';
