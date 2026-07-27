-- =============================================================
-- MERIDIAN — Admin panel
-- 012_extend_customer_permissions.sql
--
-- Supersedes the standalone ALTER TABLE I gave earlier
-- (002_extend_user_permissions.sql) — replace that file with this
-- one. Adding the 8 columns to user_permissions isn't enough on
-- its own: admin_save_customer_permissions() (from
-- 009_admin_policy_engine.sql, re-created in
-- 011_add_audit_ip_browser.sql with p_ip_address/p_browser added)
-- has its own hardcoded `cols` allow-list and a hardcoded
-- INSERT/ON CONFLICT DO UPDATE column list — neither mentions the
-- 8 new columns, so it would keep raising
-- 'Unknown permission field: %' for every one of them even after
-- the table itself was extended. This migration adds the columns
-- AND re-creates the function to actually accept them, while
-- keeping the p_ip_address/p_browser signature 011 already
-- introduced (not reverting that change).
--
-- Maps to admin-policy.js's PERMISSION_KEY_MAP:
--   transfers               -> can_transfer                (existing)
--   international_transfers -> can_international_transfer  (existing)
--   investments             -> can_invest                  (existing)
--   loans                   -> can_apply_loan               (existing)
--   beneficiary_creation    -> can_add_beneficiary          (existing)
--   internal_transfers      -> can_internal_transfer        (new)
--   card_payments           -> can_card_payment             (new)
--   atm_withdrawals         -> can_atm_withdrawal           (new)
--   mobile_banking          -> can_mobile_banking           (new)
--   online_banking          -> can_online_banking           (new)
--   bill_payments           -> can_bill_payment             (new)
--   statement_downloads     -> can_download_statement       (new)
--   profile_updates         -> can_update_profile           (new)
-- =============================================================

ALTER TABLE public.user_permissions
  ADD COLUMN IF NOT EXISTS can_internal_transfer   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_card_payment        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_atm_withdrawal      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_mobile_banking      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_online_banking      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_bill_payment        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_download_statement  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS can_update_profile      boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.admin_save_customer_permissions(
  p_user_id UUID, p_permissions JSONB, p_reason TEXT DEFAULT NULL,
  p_ip_address TEXT DEFAULT NULL, p_browser TEXT DEFAULT NULL
) RETURNS public.user_permissions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result public.user_permissions%ROWTYPE;
  cols TEXT[] := ARRAY[
    'can_transfer','can_receive','can_withdraw','can_deposit',
    'can_use_card','can_request_card','can_open_account','can_close_account',
    'can_add_beneficiary','can_international_transfer','can_apply_loan',
    'can_invest','can_contact_support',
    'can_internal_transfer','can_card_payment','can_atm_withdrawal',
    'can_mobile_banking','can_online_banking','can_bill_payment',
    'can_download_statement','can_update_profile'
  ];
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
    can_internal_transfer, can_card_payment, can_atm_withdrawal, can_mobile_banking,
    can_online_banking, can_bill_payment, can_download_statement, can_update_profile,
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
    COALESCE((p_permissions->>'can_internal_transfer')::boolean, true),
    COALESCE((p_permissions->>'can_card_payment')::boolean, true),
    COALESCE((p_permissions->>'can_atm_withdrawal')::boolean, true),
    COALESCE((p_permissions->>'can_mobile_banking')::boolean, true),
    COALESCE((p_permissions->>'can_online_banking')::boolean, true),
    COALESCE((p_permissions->>'can_bill_payment')::boolean, true),
    COALESCE((p_permissions->>'can_download_statement')::boolean, true),
    COALESCE((p_permissions->>'can_update_profile')::boolean, true),
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
    can_internal_transfer = COALESCE((p_permissions->>'can_internal_transfer')::boolean, public.user_permissions.can_internal_transfer),
    can_card_payment = COALESCE((p_permissions->>'can_card_payment')::boolean, public.user_permissions.can_card_payment),
    can_atm_withdrawal = COALESCE((p_permissions->>'can_atm_withdrawal')::boolean, public.user_permissions.can_atm_withdrawal),
    can_mobile_banking = COALESCE((p_permissions->>'can_mobile_banking')::boolean, public.user_permissions.can_mobile_banking),
    can_online_banking = COALESCE((p_permissions->>'can_online_banking')::boolean, public.user_permissions.can_online_banking),
    can_bill_payment = COALESCE((p_permissions->>'can_bill_payment')::boolean, public.user_permissions.can_bill_payment),
    can_download_statement = COALESCE((p_permissions->>'can_download_statement')::boolean, public.user_permissions.can_download_statement),
    can_update_profile = COALESCE((p_permissions->>'can_update_profile')::boolean, public.user_permissions.can_update_profile),
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
