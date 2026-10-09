-- Recurring bundles are sold as one Shopify product (see ProductBundle.bundleProductId).
ALTER TABLE `ProductBundle`
    ADD COLUMN `bundleProductId` VARCHAR(191) NULL,
    ADD COLUMN `bundleVariantId` VARCHAR(191) NULL,
    ADD COLUMN `bundleProductHandle` VARCHAR(191) NULL;
