-- AlterTable
-- ShopPlan predates prisma/migrations/ (it came from the SQLite-era
-- migrations_old), so this ALTER runs against a table Prisma has no recorded
-- history for. Plain ADD COLUMN, deliberately: `ADD COLUMN IF NOT EXISTS` is a
-- MariaDB extension that MySQL rejects outright as a syntax error.
ALTER TABLE `ShopPlan` ADD COLUMN `usageLineItemId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS `CommissionCharge` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `billingAttemptId` VARCHAR(191) NOT NULL,
    `contractId` VARCHAR(191) NOT NULL,
    `baseAmount` DOUBLE NOT NULL,
    `rate` DOUBLE NOT NULL,
    `amount` DOUBLE NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `status` VARCHAR(191) NOT NULL DEFAULT 'CHARGED',
    `reason` VARCHAR(191) NULL,
    `usageRecordId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CommissionCharge_billingAttemptId_key`(`billingAttemptId`),
    INDEX `CommissionCharge_shop_idx`(`shop`),
    INDEX `CommissionCharge_shop_createdAt_idx`(`shop`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
