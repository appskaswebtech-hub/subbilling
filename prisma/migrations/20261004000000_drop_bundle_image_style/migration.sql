-- The bundle product's main image is now its first item's image, so the
-- picture styles of 20261003000000_bundle_image_style are gone.
ALTER TABLE `ProductBundle`
    DROP COLUMN `imageStyle`,
    DROP COLUMN `imageBackground`,
    DROP COLUMN `imageBadge`,
    DROP COLUMN `imageBadgeColor`;
