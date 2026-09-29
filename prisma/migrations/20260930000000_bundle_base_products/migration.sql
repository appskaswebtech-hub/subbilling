-- Base products: choose which product pages show a bundle. Apply with
-- `prisma migrate deploy` only.
--
-- Existing bundles default to 'ITEMS', which is how every bundle behaved
-- before: shown on the page of every product in it.

-- AlterTable
ALTER TABLE `ProductBundle`
    ADD COLUMN `showOn` VARCHAR(191) NOT NULL DEFAULT 'ITEMS';

-- CreateTable
CREATE TABLE `ProductBundleBase` (
    `id`        VARCHAR(191) NOT NULL,
    `bundleId`  VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `handle`    VARCHAR(191) NOT NULL,
    `title`     VARCHAR(191) NOT NULL,

    INDEX `ProductBundleBase_bundleId_idx`(`bundleId`),
    INDEX `ProductBundleBase_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductBundleBase` ADD CONSTRAINT `ProductBundleBase_bundleId_fkey`
    FOREIGN KEY (`bundleId`) REFERENCES `ProductBundle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
