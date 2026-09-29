-- Prepaid / postpaid subscriptions and product bundles.
--
-- Plain ADD COLUMN throughout: `ADD COLUMN IF NOT EXISTS` is a MariaDB extension
-- that MySQL rejects. Apply with `prisma migrate deploy` only.

-- AlterTable
-- Payment mode and email sender per plan. Existing plans stay postpaid.
ALTER TABLE `SellingPlanGroup`
    ADD COLUMN `paymentMode`        VARCHAR(191) NOT NULL DEFAULT 'POSTPAID',
    ADD COLUMN `paymentEmailSender` VARCHAR(191) NOT NULL DEFAULT 'SHOPIFY';

-- AlterTable
-- `sellingPlanId` already exists (left over from a reverted feature) and is now
-- written again, so only the new columns are added.
ALTER TABLE `Subscription`
    ADD COLUMN `paymentMode` VARCHAR(191) NOT NULL DEFAULT 'POSTPAID',
    ADD COLUMN `bundleId`    VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `AppSettings`
    ADD COLUMN `prepaidPayWindowDays`   INTEGER      NOT NULL DEFAULT 7,
    ADD COLUMN `prepaidInvoiceLeadDays` INTEGER      NOT NULL DEFAULT 3,
    ADD COLUMN `smtpHost`               VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `smtpPort`               INTEGER      NOT NULL DEFAULT 587,
    ADD COLUMN `smtpSecure`             BOOLEAN      NOT NULL DEFAULT false,
    ADD COLUMN `smtpUser`               VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `smtpPassEnc`            TEXT         NULL,
    ADD COLUMN `smtpFrom`               VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `bundleDiscountId`       VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `PrepaidInvoice` (
    `id`             VARCHAR(191) NOT NULL,
    `shop`           VARCHAR(191) NOT NULL,
    `kind`           VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NULL,
    `draftOrderId`   VARCHAR(191) NULL,
    `invoiceUrl`     TEXT         NULL,
    `orderId`        VARCHAR(191) NULL,
    `amount`         DOUBLE       NOT NULL DEFAULT 0,
    `currency`       VARCHAR(191) NOT NULL DEFAULT 'USD',
    `cycleDate`      DATETIME(3)  NOT NULL,
    `sender`         VARCHAR(191) NOT NULL DEFAULT 'SHOPIFY',
    `status`         VARCHAR(191) NOT NULL DEFAULT 'CREATING',
    `sentAt`         DATETIME(3)  NULL,
    `reminderSentAt` DATETIME(3)  NULL,
    `dueAt`          DATETIME(3)  NULL,
    `paidAt`         DATETIME(3)  NULL,
    `error`          TEXT         NULL,
    `setupJson`      TEXT         NULL,
    `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`      DATETIME(3)  NOT NULL,

    UNIQUE INDEX `PrepaidInvoice_draftOrderId_key`(`draftOrderId`),
    UNIQUE INDEX `PrepaidInvoice_subscriptionId_cycleDate_key`(`subscriptionId`, `cycleDate`),
    INDEX `PrepaidInvoice_shop_status_idx`(`shop`, `status`),
    INDEX `PrepaidInvoice_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PrepaidInvoice` ADD CONSTRAINT `PrepaidInvoice_subscriptionId_fkey`
    FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
-- New names on purpose: an earlier, removed bundle feature left `Bundle` and
-- `BundleItem` tables behind in some databases.
CREATE TABLE `ProductBundle` (
    `id`                   VARCHAR(191) NOT NULL,
    `shop`                 VARCHAR(191) NOT NULL,
    `name`                 VARCHAR(191) NOT NULL,
    `mainProductId`        VARCHAR(191) NOT NULL,
    `type`                 VARCHAR(191) NOT NULL DEFAULT 'RECURRING',
    `discountPercent`      DOUBLE       NOT NULL DEFAULT 0,
    `active`               BOOLEAN      NOT NULL DEFAULT true,
    `position`             INTEGER      NOT NULL DEFAULT 0,
    `interval`             VARCHAR(191) NOT NULL DEFAULT 'MONTH',
    `intervalCount`        INTEGER      NOT NULL DEFAULT 1,
    `paymentMode`          VARCHAR(191) NOT NULL DEFAULT 'POSTPAID',
    `paymentEmailSender`   VARCHAR(191) NOT NULL DEFAULT 'SHOPIFY',
    `shopifyGroupId`       VARCHAR(191) NULL,
    `shopifySellingPlanId` VARCHAR(191) NULL,
    `createdAt`            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`            DATETIME(3)  NOT NULL,

    INDEX `ProductBundle_shop_idx`(`shop`),
    INDEX `ProductBundle_shop_mainProductId_idx`(`shop`, `mainProductId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductBundleItem` (
    `id`        VARCHAR(191) NOT NULL,
    `bundleId`  VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `variantId` VARCHAR(191) NOT NULL,
    `handle`    VARCHAR(191) NOT NULL,
    `title`     VARCHAR(191) NOT NULL,
    `quantity`  INTEGER      NOT NULL DEFAULT 1,

    INDEX `ProductBundleItem_bundleId_idx`(`bundleId`),
    INDEX `ProductBundleItem_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductBundleItem` ADD CONSTRAINT `ProductBundleItem_bundleId_fkey`
    FOREIGN KEY (`bundleId`) REFERENCES `ProductBundle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
