-- Rebrand (tier A): rename legacy "TBH <X>" display names to "Manut <X>" for
-- internal org entities, offices, and the seeded admin user, so live data
-- matches the rebranded seed.
--
-- Idempotent: only rows whose name starts with "TBH " (or, for the admin, the
-- exact "TBH Admin") are touched, so a re-run affects 0 rows.
--
-- Deliberately NOT changed here (registered legal names / bank details, handled
-- separately once the correct legal names are confirmed):
--   * the invoice company name + bank account (DEFAULT_INVOICE_COMPANY)
--   * the fundraising vehicles "The Binary Holdings" / "The Binary Labs"
-- Employee-id prefix (TBH-### -> MNT-###) is a separate migration.

UPDATE "entities"
SET "name" = 'Manut ' || substring("name" FROM 5)
WHERE "name" LIKE 'TBH %';

UPDATE "offices"
SET "name" = 'Manut ' || substring("name" FROM 5)
WHERE "name" LIKE 'TBH %';

UPDATE "users"
SET "name" = 'Manut Admin'
WHERE "name" = 'TBH Admin';
