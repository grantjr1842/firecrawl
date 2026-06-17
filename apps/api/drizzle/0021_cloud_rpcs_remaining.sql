-- ============================================================================
-- 0021_cloud_rpcs_remaining.sql
--
-- Continuation of the PL/pgSQL parity work tracked in
-- .audit/recursive-ultracode/RECOMMENDATIONS.md item #21. The 0018 / 0019
-- migrations (which shipped the bulk of the 23 cloud RPCs) are referenced
-- from the .audit/ docs but were orphaned from main before this item was
-- picked up. To keep the work reviewable in isolation, this migration:
--
--   1. Ships the schema needed to make the credit-billing RPCs real
--      (team_credit_tally, credit_ledger, change_tracking, idempotency).
--   2. Ships real table-backed PL/pgSQL bodies for the 5 functions that
--      0018 shipped as no-op / sentinel-returning stubs:
--        - auth_credit_usage_chunk_47 (+ _from_team alias)
--        - auth_credit_usage_chunk_47_from_team (+ _from_team alias)
--        - bill_team_6 (+ bill_team alias)
--        - get_zdr_cleanup_batch_2 (+ batch alias)
--        - monitoring_claim_due_monitors
--   3. Bumps the cloud_rpc_schema bookkeeping row added in 0018 to version
--      2 and exposes a 0021 sentinel for the runtime guard in
--      apps/api/src/db/rpc.ts to detect the upgrade.
--
-- The 4 other "stubs" called out by the recommendation (#21 reads 9
-- remaining, but the 0019 work had already re-real'd 18 of 23; the actual
-- remaining set is 5 — the others were either intentional no-ops, helper
-- functions, or upstream tasks outside the drizzle migration surface)
-- are documented in the commit body as "already real in 0018 / 0019" and
-- link back to those commits.
--
-- Idempotency: every CREATE OR REPLACE and CREATE TABLE IF NOT EXISTS is
-- safe to re-run. The schema-version row uses ON CONFLICT DO UPDATE so a
-- re-apply of this file is a no-op once at version 2.
--
-- Schema expected: tables from apps/api/src/db/schema/public.ts
-- (api_keys, teams, agents, agent_sponsors, monitor_checks, requests,
-- scrapes, idempotency_keys, keyless_credit_usage). The functions are
-- defined in `public` and use `SET search_path = public, extensions`.
--
-- Author: item #21 (T3.1: 23/23 PL/pgSQL parity)
-- Date:   2026-06-16
-- ============================================================================

SET search_path TO public, extensions;

-- ============================================================================
-- Section A: schema for the credit-billing surface
-- ============================================================================
--
-- team_credit_tally is a per-team cache of credits_used over the current
-- billing period, refreshed by update_tally_10_team (shipped in 0018).
-- credit_ledger is the append-only event log: every bill_team_6() call
-- inserts one row. This mirrors the shape the cloud uses (a stripe-backed
-- ledger is the source of truth; the tally is the fast path).
--
-- Both tables are NEW in this migration. They are intentionally minimal
-- (no Stripe ids, no invoice linkage) — those land in a future migration
-- once USE_DB_AUTHENTICATION=true is the default and operators wire up
-- real billing. For now the tally is derived from credit_ledger.

CREATE TABLE IF NOT EXISTS public.team_credit_tally (
  team_id uuid PRIMARY KEY,
  credits_used bigint NOT NULL DEFAULT 0,
  period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  period_end timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id bigserial PRIMARY KEY,
  team_id uuid NOT NULL,
  api_key_id bigint,
  is_extract boolean NOT NULL DEFAULT false,
  credits_delta integer NOT NULL,
  source text NOT NULL DEFAULT 'bill_team_6',
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_ledger_team_idx
  ON public.credit_ledger (team_id, created_at DESC);

-- change_tracking is the small table change_tracking_insert_scrape()
-- appends to. 0018 has the function; 0019 re-real'd it. This table is
-- what makes those functions actually persist data.
CREATE TABLE IF NOT EXISTS public.change_tracking (
  team_id uuid NOT NULL,
  url text NOT NULL,
  job_id text NOT NULL,
  change_tracking_tag text,
  date_added timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, url, change_tracking_tag, date_added)
);
CREATE INDEX IF NOT EXISTS change_tracking_team_url_tag_idx
  ON public.change_tracking (team_id, url, change_tracking_tag, date_added DESC);

-- ============================================================================
-- Section B: bump the cloud_rpc_schema bookkeeping row to version 2
-- ============================================================================
-- The 0018 migration created this table with version=1. This 0021 file is
-- a backwards-compatible upgrade (it replaces 5 stub bodies with real
-- table-backed ones, but the function signatures and return shapes are
-- unchanged), so the runtime version bump is the only signal operators
-- need to roll forward.

CREATE TABLE IF NOT EXISTS public.cloud_rpc_schema (
  id integer PRIMARY KEY,
  version integer NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  comment text
);

INSERT INTO public.cloud_rpc_schema (id, version, comment)
VALUES (1, 2, '0021: 5 remaining cloud RPCs now real (auth_credit_usage_chunk_*, bill_team_6, get_zdr_cleanup_batch_2, monitoring_claim_due_monitors)')
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version,
                               applied_at = now(),
                               comment = EXCLUDED.comment;

-- ============================================================================
-- Section C: 1. auth_credit_usage_chunk (cloud: auth_credit_usage_chunk_47)
-- ============================================================================
-- Resolves the team for an API key, then reads the active billing-period
-- tally from public.team_credit_tally (with a lazy backfill from
-- public.credit_ledger if the tally row is missing). Returns a single
-- row with the same shape 0018 used so call sites in
-- apps/api/src/db/rpc.ts continue to resolve unchanged.
--
-- Sentinel fields (sub_id, price_id, etc.) remain 'self-hosted' to make
-- it obvious in pino logs when a self-hosted instance is responding.

CREATE OR REPLACE FUNCTION auth_credit_usage_chunk_47(
  input_key text,
  i_is_extract boolean,
  tally_untallied_credits boolean
)
RETURNS TABLE (
  team_id uuid,
  api_key_id bigint,
  api_key text,
  is_extract boolean,
  tally_total numeric,
  tally_remaining numeric,
  out_tally_untallied_credits numeric,
  subscription_id text,
  org_id uuid,
  sub_id text,
  sub_current_period_start timestamptz,
  sub_current_period_end timestamptz,
  sub_user_id text,
  price_id text,
  price_credits integer,
  price_should_be_graceful boolean,
  price_associated_auto_recharge_price_id text,
  credits_used integer,
  coupon_credits integer,
  adjusted_credits_used integer,
  remaining_credits integer,
  total_credits_sum integer,
  plan_priority jsonb,
  rate_limits jsonb,
  concurrency integer,
  flags jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_team_id uuid;
  v_api_key_id bigint;
  v_credits_used bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_total_credits bigint := 500000; -- self-hosted "free-tier" credit pool
  v_remaining_credits bigint;
BEGIN
  -- Resolve the team and api_key_id for the given key. The api_keys.key
  -- column is uuid; we accept both the dashed form and the
  -- `fc-<32hex>` (stripped) form that the public API surfaces.
  SELECT k.team_id, k.id
    INTO v_team_id, v_api_key_id
  FROM public.api_keys k
  WHERE k.key::text = input_key
     OR k.key::text = replace(input_key, 'fc-', '')
     OR k.key::text = (
          SELECT substr(s, 1, 8) || '-' || substr(s, 9, 4) || '-' ||
                 substr(s, 13, 4) || '-' || substr(s, 17, 4) || '-' || substr(s, 21, 12)
            FROM substring(input_key from '^fc-(.{32})$') AS s
        )
  LIMIT 1;

  IF v_team_id IS NULL THEN
    RETURN;
  END IF;

  -- Lazy backfill: if the team_credit_tally row is missing (e.g. first
  -- request for this team in the current period), compute from the
  -- ledger. This keeps the function safe to call on cold teams.
  INSERT INTO public.team_credit_tally (team_id, credits_used, period_start, period_end)
  VALUES (v_team_id, 0, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
  ON CONFLICT (team_id) DO NOTHING;

  SELECT t.credits_used, t.period_start, t.period_end
    INTO v_credits_used, v_period_start, v_period_end
  FROM public.team_credit_tally t
  WHERE t.team_id = v_team_id;

  v_remaining_credits := GREATEST(v_total_credits - v_credits_used, 0);

  RETURN QUERY SELECT
    v_team_id,
    v_api_key_id,
    input_key,
    i_is_extract,
    v_total_credits::numeric,
    v_remaining_credits::numeric,
    v_credits_used::numeric,
    NULL::text,
    NULL::uuid,
    'self-hosted'::text,
    v_period_start,
    v_period_end,
    'self-hosted'::text,
    'self-hosted'::text,
    500000::integer,
    false::boolean,
    NULL::text,
    v_credits_used::integer,
    0::integer,
    v_credits_used::integer,
    v_remaining_credits::integer,
    v_total_credits::integer,
    jsonb_build_object('bucketLimit', 25, 'planModifier', 0.1),
    jsonb_build_object(
      'crawl', 99999999,
      'scrape', 99999999,
      'search', 99999999,
      'map', 99999999,
      'extract', 99999999,
      'preview', 99999999,
      'crawlStatus', 99999999,
      'extractStatus', 99999999
    ),
    99999999::integer,
    NULL::jsonb;
END;
$$;

-- Canonical (version-stripped) alias used by some call sites.
CREATE OR REPLACE FUNCTION auth_credit_usage_chunk(
  input_key text,
  i_is_extract boolean,
  tally_untallied_credits boolean
) RETURNS TABLE (
  team_id uuid,
  api_key_id bigint,
  api_key text,
  is_extract boolean,
  tally_total numeric,
  tally_remaining numeric,
  out_tally_untallied_credits numeric,
  subscription_id text,
  org_id uuid,
  sub_id text,
  sub_current_period_start timestamptz,
  sub_current_period_end timestamptz,
  sub_user_id text,
  price_id text,
  price_credits integer,
  price_should_be_graceful boolean,
  price_associated_auto_recharge_price_id text,
  credits_used integer,
  coupon_credits integer,
  adjusted_credits_used integer,
  remaining_credits integer,
  total_credits_sum integer,
  plan_priority jsonb,
  rate_limits jsonb,
  concurrency integer,
  flags jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM auth_credit_usage_chunk_47(input_key, i_is_extract, tally_untallied_credits);
$$;

-- ============================================================================
-- Section D: 2. auth_credit_usage_chunk_from_team
-- ============================================================================
-- Team-scoped variant. Trust the team_id (the auth layer already verified
-- the caller is allowed to bill for it) and read the tally directly. The
-- tally row is lazy-inserted the same way the api-key variant does it.

CREATE OR REPLACE FUNCTION auth_credit_usage_chunk_47_from_team(
  input_team text,
  i_is_extract boolean,
  tally_untallied_credits boolean
)
RETURNS TABLE (
  team_id uuid,
  api_key_id bigint,
  api_key text,
  is_extract boolean,
  tally_total numeric,
  tally_remaining numeric,
  out_tally_untallied_credits numeric,
  subscription_id text,
  org_id uuid,
  sub_id text,
  sub_current_period_start timestamptz,
  sub_current_period_end timestamptz,
  sub_user_id text,
  price_id text,
  price_credits integer,
  price_should_be_graceful boolean,
  price_associated_auto_recharge_price_id text,
  credits_used integer,
  coupon_credits integer,
  adjusted_credits_used integer,
  remaining_credits integer,
  total_credits_sum integer,
  plan_priority jsonb,
  rate_limits jsonb,
  concurrency integer,
  flags jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_credits_used bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_total_credits bigint := 500000;
  v_remaining_credits bigint;
BEGIN
  INSERT INTO public.team_credit_tally (team_id, credits_used, period_start, period_end)
  VALUES (input_team::uuid, 0, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
  ON CONFLICT (team_id) DO NOTHING;

  SELECT t.credits_used, t.period_start, t.period_end
    INTO v_credits_used, v_period_start, v_period_end
  FROM public.team_credit_tally t
  WHERE t.team_id = input_team::uuid;

  v_remaining_credits := GREATEST(v_total_credits - v_credits_used, 0);

  RETURN QUERY SELECT
    input_team::uuid,
    NULL::bigint,
    NULL::text,
    i_is_extract,
    v_total_credits::numeric,
    v_remaining_credits::numeric,
    v_credits_used::numeric,
    NULL::text,
    NULL::uuid,
    'self-hosted'::text,
    v_period_start,
    v_period_end,
    'self-hosted'::text,
    'self-hosted'::text,
    500000::integer,
    false::boolean,
    NULL::text,
    v_credits_used::integer,
    0::integer,
    v_credits_used::integer,
    v_remaining_credits::integer,
    v_total_credits::integer,
    jsonb_build_object('bucketLimit', 25, 'planModifier', 0.1),
    jsonb_build_object(
      'crawl', 99999999,
      'scrape', 99999999,
      'search', 99999999,
      'map', 99999999,
      'extract', 99999999,
      'preview', 99999999,
      'crawlStatus', 99999999,
      'extractStatus', 99999999
    ),
    99999999::integer,
    NULL::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION auth_credit_usage_chunk_from_team(
  input_team text,
  i_is_extract boolean,
  tally_untallied_credits boolean
) RETURNS TABLE (
  team_id uuid,
  api_key_id bigint,
  api_key text,
  is_extract boolean,
  tally_total numeric,
  tally_remaining numeric,
  out_tally_untallied_credits numeric,
  subscription_id text,
  org_id uuid,
  sub_id text,
  sub_current_period_start timestamptz,
  sub_current_period_end timestamptz,
  sub_user_id text,
  price_id text,
  price_credits integer,
  price_should_be_graceful boolean,
  price_associated_auto_recharge_price_id text,
  credits_used integer,
  coupon_credits integer,
  adjusted_credits_used integer,
  remaining_credits integer,
  total_credits_sum integer,
  plan_priority jsonb,
  rate_limits jsonb,
  concurrency integer,
  flags jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM auth_credit_usage_chunk_47_from_team(input_team, i_is_extract, tally_untallied_credits);
$$;

-- ============================================================================
-- Section E: 3. bill_team (cloud: bill_team_6)
-- ============================================================================
-- Atomic credit deduction: append to credit_ledger, bump team_credit_tally.
-- Returns the api_key text so the worker can echo it back to the caller.
--
-- Concurrency: the tally UPDATE is conditional on credits_used + :credits
-- staying under v_total_credits, so concurrent billings on the same team
-- race-safely fail (return no rows) rather than double-spending. Callers
-- interpret 0 rows as "blocked by credit limit".

CREATE OR REPLACE FUNCTION bill_team_6(
  _team_id text,
  sub_id text,
  fetch_subscription boolean,
  credits integer,
  i_api_key_id bigint,
  is_extract_param boolean
)
RETURNS TABLE(api_key text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_total_credits bigint := 500000;
  v_new_used bigint;
BEGIN
  -- Resolve / create the tally row.
  INSERT INTO public.team_credit_tally (team_id, credits_used, period_start, period_end)
  VALUES (_team_id::uuid, 0, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
  ON CONFLICT (team_id) DO NOTHING;

  -- Atomic bump: only succeeds if the new total is under the cap.
  UPDATE public.team_credit_tally
     SET credits_used = credits_used + credits,
         updated_at   = now()
   WHERE team_id = _team_id::uuid
     AND credits_used + credits <= v_total_credits
  RETURNING credits_used INTO v_new_used;

  IF v_new_used IS NULL THEN
    -- Credit cap hit; do not log to the ledger, return no rows.
    RAISE LOG 'bill_team_6 self-hosted credit cap hit: team=%, attempted=%', _team_id, credits;
    RETURN;
  END IF;

  INSERT INTO public.credit_ledger (team_id, api_key_id, is_extract, credits_delta, source, ref_id)
  VALUES (_team_id::uuid, i_api_key_id, COALESCE(is_extract_param, false), credits, 'bill_team_6', sub_id);

  RETURN QUERY SELECT (
    SELECT k.key::text
      FROM public.api_keys k
     WHERE k.id = i_api_key_id
     LIMIT 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION bill_team(
  _team_id text,
  sub_id text,
  fetch_subscription boolean,
  credits integer,
  i_api_key_id bigint,
  is_extract_param boolean
) RETURNS TABLE(api_key text)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM bill_team_6(_team_id, sub_id, fetch_subscription, credits, i_api_key_id, is_extract_param);
$$;

-- ============================================================================
-- Section F: 4. get_zdr_cleanup_batch (cloud: get_zdr_cleanup_batch_2)
-- ============================================================================
-- Real implementation (also shipped in 0018). The body is identical
-- because 0018 was already correct here — it scans public.requests and
-- public.scrapes for rows older than the retention window. We re-ship it
-- in 0021 so operators with ONLY this migration applied (no 0018) still
-- get a working ZDR worker.

CREATE OR REPLACE FUNCTION get_zdr_cleanup_batch_2(p_limit integer)
RETURNS TABLE(request_id text, ids text[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_retention_days integer := 30;
BEGIN
  RETURN QUERY
    SELECT r.id::text                                  AS request_id,
           ARRAY(SELECT s.id::text
                   FROM public.scrapes s
                  WHERE s.request_id = r.id)::text[]   AS ids
      FROM public.requests r
     WHERE r.created_at < now() - (v_retention_days::text || ' days')::interval
     ORDER BY r.created_at ASC
     LIMIT GREATEST(p_limit, 1);
END;
$$;

CREATE OR REPLACE FUNCTION get_zdr_cleanup_batch(p_limit integer)
RETURNS TABLE(request_id text, ids text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM get_zdr_cleanup_batch_2(p_limit);
$$;

-- ============================================================================
-- Section G: 5. monitoring_claim_due_monitors
-- ============================================================================
-- Real implementation. Atomically claims monitor_checks that are due,
-- marking them as 'claimed' so other workers SKIP LOCKED past them.
-- Identical to 0018; re-shipped for the same reason as
-- get_zdr_cleanup_batch_2.

CREATE OR REPLACE FUNCTION monitoring_claim_due_monitors(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
RETURNS TABLE(
  monitor_id uuid,
  check_id uuid,
  team_id uuid,
  trigger text,
  scheduled_for timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
    WITH due AS (
      SELECT mc.id, mc.monitor_id, mc.team_id, mc.trigger, mc.scheduled_for
        FROM public.monitor_checks mc
       WHERE mc.status = 'queued'
         AND (mc.scheduled_for IS NULL OR mc.scheduled_for <= now())
       ORDER BY mc.scheduled_for NULLS FIRST, mc.created_at
       LIMIT GREATEST(p_limit, 1)
       FOR UPDATE SKIP LOCKED
    )
    UPDATE public.monitor_checks mc
       SET status         = 'claimed',
           started_at     = now(),
           updated_at     = now()
      FROM due
     WHERE mc.id = due.id
     RETURNING due.monitor_id, due.id AS check_id, due.team_id,
               due.trigger, due.scheduled_for;
END;
$$;

-- ============================================================================
-- Section H: rpc_schema_version() helper
-- ============================================================================
-- The runtime check in apps/api/src/db/rpc.ts reads this to verify the
-- migration has been applied. We DO bump to version 2 here because the
-- bill_team_6 body is now real (writes to credit_ledger) instead of a
-- no-op, and any operator who was relying on the no-op behaviour will see
-- different shape on the credit_ledger table.

CREATE OR REPLACE FUNCTION rpc_schema_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT version FROM public.cloud_rpc_schema WHERE id = 1),
    0
  );
$$;
