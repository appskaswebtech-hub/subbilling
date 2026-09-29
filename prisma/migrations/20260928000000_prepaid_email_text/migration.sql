-- Merchant-editable wording for prepaid payment emails.
--
-- A separate migration rather than an edit to 20260925000000_prepaid_and_bundles:
-- that one may already be applied, and `migrate deploy` never re-runs an applied
-- migration. Empty / NULL means "use the built-in text". Apply with
-- `prisma migrate deploy` only.

-- AlterTable
ALTER TABLE `AppSettings`
    ADD COLUMN `prepaidInitialSubject`  VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `prepaidRenewalSubject`  VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `prepaidReminderSubject` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `prepaidInitialMessage`  TEXT         NULL,
    ADD COLUMN `prepaidRenewalMessage`  TEXT         NULL,
    ADD COLUMN `prepaidReminderMessage` TEXT         NULL;
