-- =============================================================
-- MIGRATION: 008_process_transfer_currency_conversion.sql
--
-- WHY: process_transfer() credited the receiver with
-- `balance + p_amount` — p_amount is always the SENDER-side
-- amount, in the sender's currency. For a same-currency transfer
-- that's correct by coincidence. For a cross-currency transfer
-- (USD -> NGN, etc.) it meant the receiver's NGN account got
-- credited with the raw USD number, e.g. sending $1,000 credited
-- the receiver ₦1,000 instead of ~₦1,650,000 — exactly what you
-- reported.
--
-- FIX: when a real Meridian receiver account is resolved AND its
-- currency differs from p_currency (the sender's currency, which
-- is what the transfer was denominated in), look up the exchange
-- rate from the exchange_rates table — same pair/lookup shape
-- getExchangeRate() in database.js already uses (base_currency /
-- target_currency / latest updated_at) — and credit the receiver
-- the CONVERTED amount, not the raw sender-side amount.
--
-- The transaction row itself keeps recording p_amount/p_currency
-- as before (the sender-side amount, in the sender's currency) —
-- that's what transfer.js's review/ledger/receipt already display
-- as "You sent", so that part doesn't change. A new column
-- (credited_amount) is added so the actual receiver-side amount is
-- also on record, instead of only living in a wallet debit no one
-- can trace back later.
--
-- If no exchange_rates row exists at all for the pair, this now
-- RAISES rather than silently crediting a wrong 1:1 amount — a
-- missing rate should block the transfer, not misfund someone's
-- account. (Your Edge Function refresh-exchange-rates should keep
-- this from happening in practice; this is the safety net for if
-- it hasn't run yet for a given pair.)
--
-- This replaces the process_transfer from
-- 007_process_transfer_by_identifier.sql — same signature, so no
-- drop/recreate-with-different-args needed this time.
-- =============================================================

-- New column to record what the receiver was actually credited,
-- in their own account's currency — separate from transactions.amount
-- (which stays the sender-side figure, unchanged in meaning).
alter table public.transactions
  add column if not exists credited_amount numeric,
  add column if not exists credited_currency text;

create or replace function public.process_transfer(
  p_sender_account_id uuid,
  p_amount numeric,
  p_fee numeric default 0,
  p_currency text default null,
  p_description text default null,
  p_receiver_account_id uuid default null,
  p_receiver_identifier text default null
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender public.accounts%rowtype;
  v_receiver public.accounts%rowtype;
  v_total numeric;
  v_reference text;
  v_status text;
  v_clean_identifier text;
  v_transaction public.transactions%rowtype;
  v_rate numeric;
  v_credited_amount numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than 0.';
  end if;

  select * into v_sender from public.accounts where id = p_sender_account_id for update;

  if v_sender.id is null then
    raise exception 'Sender account not found.';
  end if;

  if v_sender.user_id <> auth.uid() then
    raise exception 'You do not have permission to send from that account.';
  end if;

  v_total := p_amount + coalesce(p_fee, 0);

  if v_sender.available_balance < v_total then
    raise exception 'Insufficient funds for this transfer.';
  end if;

  if p_receiver_account_id is not null then
    select * into v_receiver from public.accounts where id = p_receiver_account_id for update;
    if v_receiver.id is null then
      raise exception 'Recipient account not found.';
    end if;
  elsif p_receiver_identifier is not null and length(trim(p_receiver_identifier)) > 0 then
    v_clean_identifier := upper(regexp_replace(p_receiver_identifier, '\s', '', 'g'));
    select * into v_receiver from public.accounts
      where regexp_replace(upper(coalesce(account_number, '')), '\s', '', 'g') = v_clean_identifier
         or regexp_replace(upper(coalesce(iban, '')), '\s', '', 'g') = v_clean_identifier
      for update
      limit 1;
  end if;

  if v_receiver.id is not null then
    v_status := 'Completed';

    -- NEW: figure out what the receiver actually gets, in their
    -- own account's currency.
    if v_receiver.currency = p_currency then
      v_rate := 1;
    else
      select exchange_rate into v_rate
        from public.exchange_rates
        where base_currency = p_currency
          and target_currency = v_receiver.currency
        order by updated_at desc
        limit 1;

      if v_rate is null then
        raise exception 'No exchange rate available for % to % — try again shortly.', p_currency, v_receiver.currency;
      end if;
    end if;

    v_credited_amount := p_amount * v_rate;
  else
    v_status := 'Processing';
    v_credited_amount := null;
  end if;

  v_reference := 'MN-' || lpad(floor(random() * 899999 + 100000)::text, 6, '0');

  insert into public.transactions (
    sender_account, receiver_account, transaction_reference,
    transaction_type, amount, fee, currency, description, status,
    credited_amount, credited_currency
  ) values (
    p_sender_account_id, v_receiver.id, v_reference,
    'transfer', p_amount, coalesce(p_fee, 0), p_currency, p_description, v_status,
    v_credited_amount, case when v_receiver.id is not null then v_receiver.currency else null end
  ) returning * into v_transaction;

  update public.accounts
    set balance = balance - v_total,
        available_balance = available_balance - v_total
    where id = p_sender_account_id;

  if v_receiver.id is not null then
    -- FIX: credit v_credited_amount (converted into the receiver's
    -- own currency) instead of the old p_amount (sender-side figure).
    update public.accounts
      set balance = balance + v_credited_amount,
          available_balance = available_balance + v_credited_amount
      where id = v_receiver.id;
  end if;

  return v_transaction;
end;
$$;

grant execute on function public.process_transfer(uuid, numeric, numeric, text, text, uuid, text) to authenticated;
