-- Bundle kinds (fixed set / build-your-own box) and pricing modes (percent,
-- fixed bundle price, tiered). Apply with `prisma migrate deploy` only.
--
-- Existing bundles become 'SET' + 'PERCENT', which is exactly how they behaved.

-- AlterTable
ALTER TABLE `ProductBundle`
    ADD COLUMN `kind`        VARCHAR(191) NOT NULL DEFAULT 'SET',
    ADD COLUMN `pricingMode` VARCHAR(191) NOT NULL DEFAULT 'PERCENT',
    ADD COLUMN `fixedPrice`  DOUBLE       NULL,
    ADD COLUMN `minItems`    INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN `tiersJson`   TEXT         NULL;
