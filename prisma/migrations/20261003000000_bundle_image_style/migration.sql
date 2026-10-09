-- How a bundle's product picture is drawn (see ProductBundle.imageStyle).
ALTER TABLE `ProductBundle`
    ADD COLUMN `imageStyle` VARCHAR(191) NOT NULL DEFAULT 'GRID',
    ADD COLUMN `imageBackground` VARCHAR(191) NOT NULL DEFAULT '#FFFFFF',
    ADD COLUMN `imageBadge` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `imageBadgeColor` VARCHAR(191) NOT NULL DEFAULT '#5B4FCB';
