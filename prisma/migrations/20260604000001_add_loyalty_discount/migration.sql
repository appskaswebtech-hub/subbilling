-- CreateTable
CREATE TABLE `LoyaltyDiscount` (
  `id`             VARCHAR(191) NOT NULL,
  `shop`           VARCHAR(191) NOT NULL,
  `name`           VARCHAR(191) NOT NULL DEFAULT 'Loyalty discount',
  `applyOnRenewal` INT          NOT NULL DEFAULT 1,
  `discountValue`  DOUBLE       NOT NULL DEFAULT 10,
  `enabled`        BOOLEAN      NOT NULL DEFAULT FALSE,
  `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt`      DATETIME(3)  NOT NULL,
  CONSTRAINT `LoyaltyDiscount_pkey` PRIMARY KEY (`id`)
);

CREATE UNIQUE INDEX `LoyaltyDiscount_shop_key` ON `LoyaltyDiscount`(`shop`);
CREATE INDEX `LoyaltyDiscount_shop_idx` ON `LoyaltyDiscount`(`shop`);
