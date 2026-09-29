-- Bundle storefront themes, and one item per product with the shopper choosing
-- the variant. Apply with `prisma migrate deploy` only.
--
-- Existing bundles keep one row per variant here; the Bundles editor collapses
-- them to one item per product the next time each bundle is opened and saved.

-- AlterTable
ALTER TABLE `ProductBundle`
    ADD COLUMN `design` VARCHAR(191) NOT NULL DEFAULT 'classic';

-- AlterTable
ALTER TABLE `ProductBundleItem`
    ADD COLUMN `variantChoice` BOOLEAN NOT NULL DEFAULT false;
