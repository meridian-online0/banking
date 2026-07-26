-- =============================================================
-- MERIDIAN — Admin panel: policy / permission / approval engine
-- Builds on the admin foundation migration (roles, is_admin(),
-- admin_audit_logs, log_admin_action()) — nothing here redefines
-- those; it only adds the tables + RPCs the policy/permissions/
-- approvals pages and transactionValidator.js need.
--
-- Every mutating RPC below follows the same shape as the
-- foundation migration's admin_freeze_account() etc.: check
-- is_admin() (or is_superadmin() where noted), do the write,
-- call log_admin_action() with target_table/target_id — the
-- REAL admin_audit_logs columns, not previous_value/new_value/
-- approval_status/affected_customer (an earlier draft of
-- admin.js assumed those; this migration and the updated
-- admin.js both use target_table/target_id/metadata instead).
-- =============================================================

-- -------------------------------------------------------------
-- 1. Bank policies (global defaults — transfer limits, fees,
--    KYC thresholds, etc. transactionValidator.js reads these)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_policies (
  policy_group TEXT PRIMARY KEY,
  policy_values JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.bank_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_policies_select_admin" ON public.bank_policies;
CREATE POLICY "bank_policies_select_admin"
  ON public.bank_policies FOR SELECT USING (public.is_admin());
-- No client-side INSERT/UPDATE policy — writes go through
-- admin_save_policy_group() below (SECURITY DEFINER), same
-- pattern as admin_audit_logs having no client write policy.

CREATE TABLE IF NOT EXISTS public.policy_change_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_group TEXT NOT NULL,
  field TEXT NOT NULL,
  previous_value JSONB,
  new_value JSONB,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_change_history_group
  ON public.policy_change_history (policy_group, changed_at DESC);

ALTER TABLE public.policy_change_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "policy_change_history_select_admin" ON public.policy_change_history;
CREATE POLICY "policy_change_history_select_admin"
  ON public.policy_change_history FOR SELECT USING (public.is_admin());

-- Upserts policy_values for a group and writes one history row per
-- changed field, so the diff shown on admin-risk.html/admin-policy
-- pages is meaningful rather than "something changed". Runs as one
-- RPC (not two client calls) so the upsert + history rows can't
-- desync if the second client call fails.
CREATE OR REPLACE FUNCTION public.admin_save_policy_group(
  p_policy_group TEXT, p_values JSONB, p_reason TEXT DEFAULT NULL
) RETURNS public.bank_policies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  previous_values JSONB;
  result public.bank_policies%ROWTYPE;
  k TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT policy_values INTO previous_values FROM public.bank_policies WHERE policy_group = p_policy_group;
  previous_values := COALESCE(previous_values, '{}'::jsonb);

  INSERT INTO public.bank_policies (policy_group, policy_values, updated_at, updated_by)
  VALUES (p_policy_group, p_values, now(), auth.uid())
  ON CONFLICT (policy_group) DO UPDATE
    SET policy_values = EXCLUDED.policy_values, updated_at = now(), updated_by = auth.uid()
  RETURNING * INTO result;

  FOR k IN SELECT jsonb_object_keys(p_values) LOOP
    IF (previous_values -> k) IS DISTINCT FROM (p_values -> k) THEN
      INSERT INTO public.policy_change_history (policy_group, field, previous_value, new_value, changed_by)
      VALUES (p_policy_group, k, previous_values -> k, p_values -> k, auth.uid());
    END IF;
  END LOOP;

  PERFORM public.log_admin_action('save_policy_group', 'bank_policies', NULL, p_reason,
    jsonb_build_object('policy_group', p_policy_group));

  RETURN result;
END;
$$;

-- -------------------------------------------------------------
-- 2. Per-customer permissions
-- -----------------------------------------------------------
-- FLAG: only a starter set of boolean flags is defined below.
-- admin-policy.js's actual checkbox list must match these column
-- names exactly (a .upsert() with an unknown key errors), so
-- rename/add columns here to match that page before relying on
-- this table — don't assume this list is complete.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_permissions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  can_transfer BOOLEAN NOT NULL DEFAULT true,
  can_receive BOOLEAN NOT NULL DEFAULT true,
  can_withdraw BOOLEAN NOT NULL DEFAULT true,
  can_deposit BOOLEAN NOT NULL DEFAULT true,
  can_use_card BOOLEAN NOT NULL DEFAULT true,
  can_request_card BOOLEAN NOT NULL DEFAULT true,
  can_open_account BOOLEAN NOT NULL DEFAULT true,
  can_close_account BOOLEAN NOT NULL DEFAULT true,
  can_add_beneficiary BOOLEAN NOT NULL DEFAULT true,
  can_international_transfer BOOLEAN NOT NULL DEFAULT true,
  can_apply_loan BOOLEAN NOT NULL DEFAULT true,
  can_invest BOOLEAN NOT NULL DEFAULT true,
  can_contact_support BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_permissions_select_admin" ON public.user_permissions;
CREATE POLICY "user_permissions_select_admin"
  ON public.user_permissions FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "user_permissions_select_own" ON public.user_permissions;
CREATE POLICY "user_permissions_select_own"
  ON public.user_permissions FOR SELECT USING (auth.uid() = user_id);
-- transactionValidator.js can therefore check a customer's own
-- flags client-side too, same as any owner-scoped read elsewhere.

-- -------------------------------------------------------------
-- 3. Per-customer transfer limit overrides
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_limit_overrides (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  override_values JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.user_limit_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_limit_overrides_select_admin" ON public.user_limit_overrides;
CREATE POLICY "user_limit_overrides_select_admin"
  ON public.user_limit_overrides FOR SELECT USING (public.is_admin());

DROP POLICY IF EXISTS "user_limit_overrides_select_own" ON public.user_limit_overrides;
CREATE POLICY "user_limit_overrides_select_own"
  ON public.user_limit_overrides FOR SELECT USING (auth.uid() = user_id);

-- Single RPC for both tables above so admin.js never writes
-- user_permissions/user_limit_overrides directly from the client —
-- keeps the audit trail guaranteed rather than optional.
CREATE OR REPLACE FUNCTION public.admin_save_customer_permissions(
  p_user_id UUID, p_permissions JSONB, p_reason TEXT DEFAULT NULL
) RETURNS public.user_permissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result public.user_permissions%ROWTYPE;
  cols TEXT[] := ARRAY['can_transfer','can_receive','can_withdraw','can_deposit',
    'can_use_card','can_request_card','can_open_account','can_close_account',
    'can_add_beneficiary','can_international_transfer','can_apply_loan',
    'can_invest','can_contact_support'];
  k TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  FOR k IN SELECT jsonb_object_keys(p_permissions) LOOP
    IF NOT (k = ANY(cols)) THEN
      RAISE EXCEPTION 'Unknown permission field: %', k;
    END IF;
  END LOOP;

  INSERT INTO public.user_permissions (
    user_id, can_transfer, can_receive, can_withdraw, can_deposit, can_use_card,
    can_request_card, can_open_account, can_close_account, can_add_beneficiary,
    can_international_transfer, can_apply_loan, can_invest, can_contact_support,
    updated_at, updated_by
  ) VALUES (
    p_user_id,
    COALESCE((p_permissions->>'can_transfer')::boolean, true),
    COALESCE((p_permissions->>'can_receive')::boolean, true),
    COALESCE((p_permissions->>'can_withdraw')::boolean, true),
    COALESCE((p_permissions->>'can_deposit')::boolean, true),
    COALESCE((p_permissions->>'can_use_card')::boolean, true),
    COALESCE((p_permissions->>'can_request_card')::boolean, true),
    COALESCE((p_permissions->>'can_open_account')::boolean, true),
    COALESCE((p_permissions->>'can_close_account')::boolean, true),
    COALESCE((p_permissions->>'can_add_beneficiary')::boolean, true),
    COALESCE((p_permissions->>'can_international_transfer')::boolean, true),
    COALESCE((p_permissions->>'can_apply_loan')::boolean, true),
    COALESCE((p_permissions->>'can_invest')::boolean, true),
    COALESCE((p_permissions->>'can_contact_support')::boolean, true),
    now(), auth.uid()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    can_transfer = COALESCE((p_permissions->>'can_transfer')::boolean, public.user_permissions.can_transfer),
    can_receive = COALESCE((p_permissions->>'can_receive')::boolean, public.user_permissions.can_receive),
    can_withdraw = COALESCE((p_permissions->>'can_withdraw')::boolean, public.user_permissions.can_withdraw),
    can_deposit = COALESCE((p_permissions->>'can_deposit')::boolean, public.user_permissions.can_deposit),
    can_use_card = COALESCE((p_permissions->>'can_use_card')::boolean, public.user_permissions.can_use_card),
    can_request_card = COALESCE((p_permissions->>'can_request_card')::boolean, public.user_permissions.can_request_card),
    can_open_account = COALESCE((p_permissions->>'can_open_account')::boolean, public.user_permissions.can_open_account),
    can_close_account = COALESCE((p_permissions->>'can_close_account')::boolean, public.user_permissions.can_close_account),
    can_add_beneficiary = COALESCE((p_permissions->>'can_add_beneficiary')::boolean, public.user_permissions.can_add_beneficiary),
    can_international_transfer = COALESCE((p_permissions->>'can_international_transfer')::boolean, public.user_permissions.can_international_transfer),
    can_apply_loan = COALESCE((p_permissions->>'can_apply_loan')::boolean, public.user_permissions.can_apply_loan),
    can_invest = COALESCE((p_permissions->>'can_invest')::boolean, public.user_permissions.can_invest),
    can_contact_support = COALESCE((p_permissions->>'can_contact_support')::boolean, public.user_permissions.can_contact_support),
    updated_at = now(), updated_by = auth.uid()
  RETURNING * INTO result;

  PERFORM public.log_admin_action('update_customer_permissions', 'user_permissions', p_user_id, p_reason, p_permissions);

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_customer_limit_overrides(
  p_user_id UUID, p_overrides JSONB, p_reason TEXT DEFAULT NULL
) RETURNS public.user_limit_overrides
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result public.user_limit_overrides%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  INSERT INTO public.user_limit_overrides (user_id, override_values, updated_at, updated_by)
  VALUES (p_user_id, p_overrides, now(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET override_values = EXCLUDED.override_values, updated_at = now(), updated_by = auth.uid()
  RETURNING * INTO result;

  PERFORM public.log_admin_action('update_customer_limit_overrides', 'user_limit_overrides', p_user_id, p_reason, p_overrides);

  RETURN result;
END;
$$;

-- -------------------------------------------------------------
-- 4. Account status + generic restriction actions
-- -----------------------------------------------------------
-- Distinct from admin_freeze_account() (which freezes an ACCOUNT
-- row) — this sets status on the user_profiles level for things
-- like a full account-status control (Active/Restricted/
-- Suspended/Closed) at the customer level, per the spec's
-- "Account Status control" mentioned against migration 007.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_account_status(
  p_user_id UUID, p_status TEXT, p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_status NOT IN ('active', 'restricted', 'suspended', 'closed', 'Pending', 'rejected') THEN
    RAISE EXCEPTION 'Invalid account status.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to change account status.';
  END IF;

  UPDATE public.user_profiles SET account_status = p_status WHERE id = p_user_id;

  INSERT INTO public.restriction_history (user_id, action, reason, performed_by)
  VALUES (p_user_id, 'set_account_status:' || p_status, p_reason, auth.uid());

  PERFORM public.log_admin_action('set_account_status', 'user_profiles', p_user_id, p_reason,
    jsonb_build_object('new_status', p_status));
END;
$$;

CREATE TABLE IF NOT EXISTS public.restriction_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  reason TEXT,
  performed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restriction_history_user
  ON public.restriction_history (user_id, performed_at DESC);

ALTER TABLE public.restriction_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "restriction_history_select_admin" ON public.restriction_history;
CREATE POLICY "restriction_history_select_admin"
  ON public.restriction_history FOR SELECT USING (public.is_admin());

-- Generic restriction action (block transfers, block card use,
-- block login, etc.) distinct from a full status change above.
-- p_action is free text ('block_transfers' | 'unblock_transfers' |
-- 'block_login' | ... ) — validated app-side in admin-policy.js
-- for now; add a CHECK constraint here once that list is final.
CREATE OR REPLACE FUNCTION public.admin_restriction_action(
  p_action TEXT, p_user_id UUID, p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required for a restriction action.';
  END IF;

  INSERT INTO public.restriction_history (user_id, action, reason, performed_by)
  VALUES (p_user_id, p_action, p_reason, auth.uid());

  PERFORM public.log_admin_action('restriction_action', 'user_profiles', p_user_id, p_reason,
    jsonb_build_object('action', p_action));
END;
$$;

-- -------------------------------------------------------------
-- 5. Approval workflow (maker-checker)
-- -----------------------------------------------------------
-- A request is created by whatever future flow needs sign-off
-- (e.g. a large limit override); this migration adds the table
-- and the decide-RPC. Nothing yet inserts into approval_requests —
-- that lands with whichever admin page/service first needs to
-- require a second approver (flagging this rather than guessing
-- which action types require approval).
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  customer_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  previous_value JSONB,
  new_value JSONB,
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON public.approval_requests (status, requested_at DESC);

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "approval_requests_select_admin" ON public.approval_requests;
CREATE POLICY "approval_requests_select_admin"
  ON public.approval_requests FOR SELECT USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.admin_get_approval_stats()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'pending', (SELECT count(*) FROM public.approval_requests WHERE status = 'pending'),
    'approved', (SELECT count(*) FROM public.approval_requests WHERE status = 'approved'),
    'rejected', (SELECT count(*) FROM public.approval_requests WHERE status = 'rejected')
  );
$$;

-- Enforces "no admin approves their own request" server-side —
-- the disabled-button check in admin-approvals.js is UX only.
CREATE OR REPLACE FUNCTION public.admin_decide_approval(
  p_request_id UUID, p_decision TEXT, p_reason TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  req public.approval_requests%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid decision.';
  END IF;

  SELECT * INTO req FROM public.approval_requests WHERE id = p_request_id;
  IF req.id IS NULL THEN
    RAISE EXCEPTION 'Approval request not found.';
  END IF;
  IF req.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been decided.';
  END IF;
  IF req.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot decide your own request.';
  END IF;

  UPDATE public.approval_requests
    SET status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
    WHERE id = p_request_id;

  -- NOTE: this does not yet apply the underlying change (e.g.
  -- actually saving the limit override the request was for) —
  -- that application step depends on `type` and isn't defined
  -- until a request-producing flow exists. Flagging rather than
  -- guessing a dispatch table for types that don't exist yet.

  PERFORM public.log_admin_action('decide_approval', 'approval_requests', p_request_id, p_reason,
    jsonb_build_object('decision', p_decision, 'request_type', req.type));
END;
$$;

-- -------------------------------------------------------------
-- 6. Risk flags (admin-risk.html) — table only; no detection
--    engine populates this yet (see admin.js header note), but
--    the dismiss/escalate/resolve actions admin.js already calls
--    need somewhere to write to.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.risk_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  severity TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high'
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'escalated' | 'resolved'
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_flags_status ON public.risk_flags (status, created_at DESC);

ALTER TABLE public.risk_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_flags_select_admin" ON public.risk_flags;
CREATE POLICY "risk_flags_select_admin"
  ON public.risk_flags FOR SELECT USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.admin_dismiss_risk_flag(p_flag_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'resolved' WHERE id = p_flag_id;
  PERFORM public.log_admin_action('dismiss_risk_flag', 'risk_flags', p_flag_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_escalate_risk_flag(p_flag_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'escalated' WHERE id = p_flag_id;
  PERFORM public.log_admin_action('escalate_risk_flag', 'risk_flags', p_flag_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_resolve_risk_flag(p_flag_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'resolved' WHERE id = p_flag_id;
  PERFORM public.log_admin_action('resolve_risk_flag', 'risk_flags', p_flag_id, p_reason);
END;
$$;
