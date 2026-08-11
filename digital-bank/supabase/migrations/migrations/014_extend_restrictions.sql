-- =============================================================
-- MERIDIAN — Admin panel
-- 014_extend_restrictions.sql
--
-- Makes admin_restriction_action() actually enforce something,
-- instead of only writing an audit row (see admin.js's own
-- "STILL OPEN" note this migration resolves). Reuses existing
-- user_permissions columns from 009/012 wherever one already
-- exists for a given chip; adds only the columns that have no
-- existing home (force_logout_at, must_reset_password,
-- failed_login_count, can_receive_notifications).
--
-- Also adds admin_freeze_customer_accounts() /
-- admin_unfreeze_customer_accounts() — the "Freeze customer" /
-- "Unfreeze customer" chips act on a whole customer, but the
-- existing admin_freeze_account()/admin_unfreeze_account() take a
-- single account_id. Freezes ALL of that customer's accounts at
-- once — a judgment call, not confirmed against a spec: revisit
-- if a per-account picker is wanted instead later.
-- =============================================================

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS force_logout_at     timestamptz,
  ADD COLUMN IF NOT EXISTS must_reset_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_login_count  integer NOT NULL DEFAULT 0;

ALTER TABLE public.user_permissions
  ADD COLUMN IF NOT EXISTS can_receive_notifications boolean NOT NULL DEFAULT true;

-- -------------------------------------------------------------
-- Rewritten: real per-action effects, not just an audit row.
-- Any action not matched below still falls through to only the
-- restriction_history insert, same as before — so a future,
-- not-yet-mapped chip fails safe instead of erroring.
-- -------------------------------------------------------------
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

  -- Several branches below target user_permissions; make sure a
  -- row exists for this customer first (nothing guarantees one is
  -- created at signup).
  INSERT INTO public.user_permissions (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  IF p_action = 'disable_transfers' THEN
    UPDATE public.user_permissions SET can_transfer = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_investments' THEN
    UPDATE public.user_permissions SET can_invest = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_cards' THEN
    UPDATE public.user_permissions SET can_use_card = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_loans' THEN
    UPDATE public.user_permissions SET can_apply_loan = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_withdrawals' THEN
    UPDATE public.user_permissions SET can_withdraw = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_deposits' THEN
    UPDATE public.user_permissions SET can_deposit = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_statements' THEN
    UPDATE public.user_permissions SET can_download_statement = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'disable_notifications' THEN
    UPDATE public.user_permissions SET can_receive_notifications = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'lock_online_banking' THEN
    UPDATE public.user_permissions SET can_online_banking = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'lock_mobile_banking' THEN
    UPDATE public.user_permissions SET can_mobile_banking = false, updated_at = now(), updated_by = auth.uid() WHERE user_id = p_user_id;
  ELSIF p_action = 'require_new_kyc' THEN
    UPDATE public.user_profiles SET account_status = 'Pending' WHERE id = p_user_id;
  ELSIF p_action = 'require_password_reset' THEN
    UPDATE public.user_profiles SET must_reset_password = true WHERE id = p_user_id;
  ELSIF p_action = 'reset_failed_login_counter' THEN
    UPDATE public.user_profiles SET failed_login_count = 0 WHERE id = p_user_id;
  ELSIF p_action IN ('force_logout', 'clear_device_list') THEN
    -- Per instruction: Clear Device List signs out every session,
    -- same real effect as Force Logout. force_logout_at is what
    -- requireAuth() checks client-side on the next page load;
    -- closing login_sessions rows also updates the visible
    -- "Active sessions" list on profile.html immediately.
    UPDATE public.user_profiles SET force_logout_at = now() WHERE id = p_user_id;
    UPDATE public.login_sessions SET logout_time = now() WHERE user_id = p_user_id AND logout_time IS NULL;
  END IF;

  INSERT INTO public.restriction_history (user_id, action, reason, performed_by)
  VALUES (p_user_id, p_action, p_reason, auth.uid());

  PERFORM public.log_admin_action('restriction_action', 'user_profiles', p_user_id, p_reason,
    jsonb_build_object('action', p_action));
END;
$$;

-- -------------------------------------------------------------
-- Customer-level freeze/unfreeze — all accounts at once.
-- NOTE: assumes notify_user()'s parameter order from
-- admin_freeze_account() (user_id, title, body, category, type,
-- target_id, ?, link) — target_id passed as NULL here since this
-- isn't about one specific account. Flagging since I haven't seen
-- notify_user()'s own definition to confirm the 7th parameter.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_freeze_customer_accounts(p_user_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  UPDATE public.accounts SET account_status = 'frozen' WHERE user_id = p_user_id;

  PERFORM public.notify_user(
    p_user_id, 'Account frozen',
    'Your accounts have been temporarily frozen. Contact support for details.',
    'security', 'account_frozen', NULL, NULL, 'support.html'
  );

  INSERT INTO public.restriction_history (user_id, action, reason, performed_by)
  VALUES (p_user_id, 'freeze_customer', p_reason, auth.uid());

  PERFORM public.log_admin_action('freeze_customer_accounts', 'accounts', p_user_id, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unfreeze_customer_accounts(p_user_id UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  UPDATE public.accounts SET account_status = 'active' WHERE user_id = p_user_id AND account_status = 'frozen';

  PERFORM public.notify_user(
    p_user_id, 'Account reinstated',
    'Your accounts have been unfrozen and are active again.',
    'security', 'account_unfrozen', NULL, NULL, 'accounts.html'
  );

  INSERT INTO public.restriction_history (user_id, action, reason, performed_by)
  VALUES (p_user_id, 'unfreeze_customer', p_reason, auth.uid());

  PERFORM public.log_admin_action('unfreeze_customer_accounts', 'accounts', p_user_id, p_reason);
END;
$$;
