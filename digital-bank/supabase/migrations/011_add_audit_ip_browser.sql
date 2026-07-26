-- =============================================================
-- MERIDIAN — Admin panel
-- 011_add_audit_ip_browser.sql
--
-- Adds ip_address/browser to admin_audit_logs and threads them
-- through log_admin_action() and every mutating admin_* RPC that
-- calls it, from both admin_schema.sql and
-- 009_admin_policy_engine.sql. New parameters are added at the
-- END of each function's signature with DEFAULT NULL, so this is
-- backward-compatible: existing supabase.rpc(name, {...}) calls
-- that don't send p_ip_address/p_browser keep working unchanged.
-- admin.js is updated separately to actually send these values.
-- =============================================================

ALTER TABLE public.admin_audit_logs
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS browser    TEXT;

-- -------------------------------------------------------------
-- log_admin_action() — now accepts ip/browser
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_action TEXT, p_target_table TEXT, p_target_id UUID,
  p_reason TEXT DEFAULT NULL, p_metadata JSONB DEFAULT '{}',
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.admin_audit_logs
    (admin_id, action, target_table, target_id, reason, metadata, ip_address, browser)
  VALUES
    (auth.uid(), p_action, p_target_table, p_target_id, p_reason, p_metadata, p_ip_address, p_browser);
END;
$$;

-- -------------------------------------------------------------
-- admin_schema.sql RPCs — re-created with p_ip_address/p_browser
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_freeze_account(
  p_account_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  owner_uid UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT user_id INTO owner_uid FROM public.accounts WHERE id = p_account_id;
  IF owner_uid IS NULL THEN
    RAISE EXCEPTION 'Account not found.';
  END IF;

  UPDATE public.accounts SET account_status = 'frozen' WHERE id = p_account_id;

  PERFORM public.notify_user(
    owner_uid, 'Account frozen',
    'One of your accounts has been temporarily frozen. Contact support for details.',
    'security', 'account_frozen', p_account_id, NULL, 'support.html'
  );

  PERFORM public.log_admin_action(
    p_action => 'freeze_account', p_target_table => 'accounts', p_target_id => p_account_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_unfreeze_account(
  p_account_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  owner_uid UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT user_id INTO owner_uid FROM public.accounts WHERE id = p_account_id;
  IF owner_uid IS NULL THEN
    RAISE EXCEPTION 'Account not found.';
  END IF;

  UPDATE public.accounts SET account_status = 'active' WHERE id = p_account_id;

  PERFORM public.notify_user(
    owner_uid, 'Account reinstated',
    'Your account has been unfrozen and is active again.',
    'security', 'account_unfrozen', p_account_id, NULL, 'accounts.html'
  );

  PERFORM public.log_admin_action(
    p_action => 'unfreeze_account', p_target_table => 'accounts', p_target_id => p_account_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_kyc(
  p_user_id UUID, p_reason TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  UPDATE public.user_profiles SET account_status = 'active' WHERE id = p_user_id;

  PERFORM public.log_admin_action(
    p_action => 'approve_kyc', p_target_table => 'user_profiles', p_target_id => p_user_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_kyc(
  p_user_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reject KYC.';
  END IF;

  UPDATE public.user_profiles SET account_status = 'rejected' WHERE id = p_user_id;

  PERFORM public.log_admin_action(
    p_action => 'reject_kyc', p_target_table => 'user_profiles', p_target_id => p_user_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reverse_transaction(
  p_transaction_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  new_tx_id UUID;
  sender_uid UUID;
  receiver_uid UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to reverse a transaction.';
  END IF;

  SELECT * INTO tx FROM public.transactions WHERE id = p_transaction_id;
  IF tx.id IS NULL THEN
    RAISE EXCEPTION 'Transaction not found.';
  END IF;
  IF tx.status = 'Reversed' OR tx.reversed_by IS NOT NULL THEN
    RAISE EXCEPTION 'This transaction has already been reversed.';
  END IF;

  IF tx.sender_account IS NOT NULL THEN
    UPDATE public.accounts
      SET balance = balance + tx.amount, available_balance = available_balance + tx.amount
      WHERE id = tx.sender_account;
    SELECT user_id INTO sender_uid FROM public.accounts WHERE id = tx.sender_account;
  END IF;

  IF tx.receiver_account IS NOT NULL THEN
    UPDATE public.accounts
      SET balance = balance - tx.amount, available_balance = available_balance - tx.amount
      WHERE id = tx.receiver_account;
    SELECT user_id INTO receiver_uid FROM public.accounts WHERE id = tx.receiver_account;
  END IF;

  INSERT INTO public.transactions (
    sender_account, receiver_account, amount, fee, currency,
    description, transaction_reference, status, transaction_type
  ) VALUES (
    tx.receiver_account, tx.sender_account, tx.amount, 0, tx.currency,
    format('Reversal of %s — %s', tx.transaction_reference, p_reason),
    'REV-' || substr(tx.transaction_reference, 1, 40), 'Completed', 'reversal'
  ) RETURNING id INTO new_tx_id;

  UPDATE public.transactions SET status = 'Reversed', reversed_by = new_tx_id WHERE id = p_transaction_id;

  IF sender_uid IS NOT NULL THEN
    PERFORM public.notify_user(sender_uid, 'Transaction reversed',
      format('%s %s from %s was reversed by our team.', tx.currency, tx.amount, tx.transaction_reference),
      'banking', 'transaction_reversed', tx.sender_account, new_tx_id, 'transactions.html');
  END IF;
  IF receiver_uid IS NOT NULL THEN
    PERFORM public.notify_user(receiver_uid, 'Transaction reversed',
      format('%s %s to %s was reversed by our team.', tx.currency, tx.amount, tx.transaction_reference),
      'banking', 'transaction_reversed', tx.receiver_account, new_tx_id, 'transactions.html');
  END IF;

  PERFORM public.log_admin_action(
    p_action => 'reverse_transaction', p_target_table => 'transactions', p_target_id => p_transaction_id,
    p_reason => p_reason,
    p_metadata => jsonb_build_object('reversal_transaction_id', new_tx_id, 'amount', tx.amount, 'currency', tx.currency),
    p_ip_address => p_ip_address, p_browser => p_browser
  );

  RETURN new_tx_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_card_status(
  p_card_id UUID, p_status TEXT, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_status NOT IN ('Active', 'Frozen', 'Cancelled', 'Pending') THEN
    RAISE EXCEPTION 'Invalid card status.';
  END IF;

  UPDATE public.cards SET card_status = p_status WHERE id = p_card_id;

  PERFORM public.log_admin_action(
    p_action => 'set_card_status', p_target_table => 'cards', p_target_id => p_card_id,
    p_reason => p_reason, p_metadata => jsonb_build_object('new_status', p_status),
    p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  p_user_id UUID, p_role TEXT, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_superadmin() THEN
    RAISE EXCEPTION 'Only a superadmin can change roles.';
  END IF;
  IF p_role NOT IN ('customer', 'support', 'admin', 'superadmin') THEN
    RAISE EXCEPTION 'Invalid role.';
  END IF;

  UPDATE public.user_profiles SET role = p_role WHERE id = p_user_id;

  PERFORM public.log_admin_action(
    p_action => 'set_user_role', p_target_table => 'user_profiles', p_target_id => p_user_id,
    p_reason => p_reason, p_metadata => jsonb_build_object('new_role', p_role),
    p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

-- -------------------------------------------------------------
-- 009_admin_policy_engine.sql RPCs — re-created with
-- p_ip_address/p_browser
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_save_policy_group(
  p_policy_group TEXT, p_values JSONB, p_reason TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'save_policy_group', p_target_table => 'bank_policies', p_target_id => NULL,
    p_reason => p_reason, p_metadata => jsonb_build_object('policy_group', p_policy_group),
    p_ip_address => p_ip_address, p_browser => p_browser
  );

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_customer_permissions(
  p_user_id UUID, p_permissions JSONB, p_reason TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'update_customer_permissions', p_target_table => 'user_permissions', p_target_id => p_user_id,
    p_reason => p_reason, p_metadata => p_permissions,
    p_ip_address => p_ip_address, p_browser => p_browser
  );

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_customer_limit_overrides(
  p_user_id UUID, p_overrides JSONB, p_reason TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'update_customer_limit_overrides', p_target_table => 'user_limit_overrides', p_target_id => p_user_id,
    p_reason => p_reason, p_metadata => p_overrides,
    p_ip_address => p_ip_address, p_browser => p_browser
  );

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_account_status(
  p_user_id UUID, p_status TEXT, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'set_account_status', p_target_table => 'user_profiles', p_target_id => p_user_id,
    p_reason => p_reason, p_metadata => jsonb_build_object('new_status', p_status),
    p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_restriction_action(
  p_action TEXT, p_user_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'restriction_action', p_target_table => 'user_profiles', p_target_id => p_user_id,
    p_reason => p_reason, p_metadata => jsonb_build_object('action', p_action),
    p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decide_approval(
  p_request_id UUID, p_decision TEXT, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
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

  PERFORM public.log_admin_action(
    p_action => 'decide_approval', p_target_table => 'approval_requests', p_target_id => p_request_id,
    p_reason => p_reason, p_metadata => jsonb_build_object('decision', p_decision, 'request_type', req.type),
    p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_dismiss_risk_flag(
  p_flag_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'resolved' WHERE id = p_flag_id;
  PERFORM public.log_admin_action(
    p_action => 'dismiss_risk_flag', p_target_table => 'risk_flags', p_target_id => p_flag_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_escalate_risk_flag(
  p_flag_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'escalated' WHERE id = p_flag_id;
  PERFORM public.log_admin_action(
    p_action => 'escalate_risk_flag', p_target_table => 'risk_flags', p_target_id => p_flag_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_resolve_risk_flag(
  p_flag_id UUID, p_reason TEXT,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized.'; END IF;
  UPDATE public.risk_flags SET status = 'resolved' WHERE id = p_flag_id;
  PERFORM public.log_admin_action(
    p_action => 'resolve_risk_flag', p_target_table => 'risk_flags', p_target_id => p_flag_id,
    p_reason => p_reason, p_ip_address => p_ip_address, p_browser => p_browser
  );
END;
$$;
