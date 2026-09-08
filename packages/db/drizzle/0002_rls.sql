-- Idempotent RLS for the tables historically covered by
-- packages/database/scripts/apply-rls.ts.
--
-- IMPORTANT (Wave 6 / Hyperdrive): the Cloudflare Worker connects through
-- Hyperdrive as the Postgres owner (or an equivalently privileged role).
-- Owner connections bypass RLS, so these policies do NOT enforce ERP
-- isolation for the edge/API runtime. Tenancy for ERP rows is
-- application-layer only (Wave 3 org-scope helpers + service filters).
-- RLS here still locks down anon/authenticated PostgREST-style roles the
-- way the Prisma-era script did — do not claim DB-enforced ERP isolation.
--
-- Statement breakpoints kept for drizzle-kit migrate.

CREATE OR REPLACE FUNCTION public.is_service_role()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT current_setting('role', true) IN ('service_role', 'supabase_admin')
      OR current_user = 'postgres';
$fn$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'entities','users','sessions','roles','user_roles','role_permissions',
    'module_access','module_owners','leave_types','leave_balances','leave_requests',
    'payroll_runs','payslips','consultant_invoices','esop_grants','onboarding_runs',
    'training_modules','training_completions','visa_records','benefits','benefit_enrollments',
    'chart_of_accounts','journal_entries','journal_entry_lines','invoices','bank_transactions',
    'bnry_transactions','expense_categories','expenses','partners','partner_contacts','deals',
    'projects','project_tasks','offices','office_desks','desk_bookings','meeting_rooms',
    'room_bookings','assets','channels','messages','wall_posts','wall_comments','company_news',
    'company_dates','aria_conversations','aria_messages','investors','investments',
    'data_room_documents','investor_updates','audit_log','user_settings','system_settings',
    'file_uploads'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY service_role_full_access ON public.%I FOR ALL USING (public.is_service_role()) WITH CHECK (public.is_service_role())',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
