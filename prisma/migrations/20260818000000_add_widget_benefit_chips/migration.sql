-- AlterTable
-- Newline-separated benefit chip labels for the "benefits" widget design.
-- VarChar(1000) rather than Prisma's default 191: six chips joined can exceed it.
ALTER TABLE `AppSettings`
  ADD COLUMN `widgetBenefitChips` VARCHAR(1000) NOT NULL DEFAULT '';
