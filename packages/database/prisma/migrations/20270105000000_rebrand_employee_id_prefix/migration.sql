-- Rebrand (tier A): employee-id prefix TBH-### -> MNT-###.
-- Idempotent: only rows matching ^TBH-<digits>$ are rewritten, so a re-run
-- affects 0 rows. The numeric suffix and its zero-padding are preserved
-- (TBH-0042 -> MNT-0042), and the rename is a bijection so employee_id
-- uniqueness is retained. Prisma `migrate deploy` runs this before the Worker
-- deploy, so the new generator/regex (which read the MNT- prefix) only see
-- rewritten rows.
UPDATE "users"
SET "employee_id" = 'MNT-' || substring("employee_id" FROM 5)
WHERE "employee_id" ~ '^TBH-[0-9]+$';
