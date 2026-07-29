-- Add widget appearance settings to AppSettings
ALTER TABLE `AppSettings`
  ADD COLUMN `widgetPrimaryColor` VARCHAR(191) NOT NULL DEFAULT '#5B4FCB',
  ADD COLUMN `widgetBadgeColor`   VARCHAR(191) NOT NULL DEFAULT '#F5A623',
  ADD COLUMN `widgetBorderRadius` INT          NOT NULL DEFAULT 10,
  ADD COLUMN `widgetShowOnetime`  BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN `widgetDesign`       VARCHAR(191) NOT NULL DEFAULT 'arctic';
