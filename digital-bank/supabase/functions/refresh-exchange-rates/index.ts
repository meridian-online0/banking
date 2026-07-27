/* =============================================================
   MERIDIAN — supabase/functions/refresh-exchange-rates/index.ts

   Fetches live FX rates for every SUPPORTED_CURRENCIES pair from
   open.er-api.com (free, no API key required, ~160 currencies
   including NGN and SGD) and refreshes the `exchange_rates` table.

   Mirrors the refresh-crypto-prices function's shape: runs with
   the service role key (never exposed to the browser), is invoked
   on-demand by database.js's getExchangeRate() when the cached
   rate looks stale, and is safe to call repeatedly.

   Deploy:
     supabase functions deploy refresh-exchange-rates

   Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set —
   these are injected automatically for Edge Functions deployed to
   a linked project, so no manual secret-setting is needed for them.

   NOTE ON UPSERT: this does NOT rely on a unique constraint on
   (base_currency, target_currency) existing in exchange_rates,
   since that wasn't confirmed against your schema.sql. Instead it
   deletes the currently-tracked pairs and re-inserts fresh rows in
   one pass. If you later add a unique constraint, you can switch
   this to a single upsert() call with onConflict for less churn —
   not necessary for correctness either way.
   ============================================================= */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Keep this in sync with SUPPORTED_CURRENCIES in supabase/database.js.
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD', 'JPY', 'NGN', 'CAD', 'AUD', 'CHF'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const rows: Array<{ base_currency: string; target_currency: string; exchange_rate: number; updated_at: string }> = [];
    const now = new Date().toISOString();

    // open.er-api.com returns one base currency's full rate table per
    // call, so we fetch once per SUPPORTED_CURRENCIES entry (9 calls)
    // rather than once per pair (72 calls) — well inside free-tier limits.
    for (const base of SUPPORTED_CURRENCIES) {
      let res: Response;
      try {
        res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      } catch (fetchErr) {
        console.error(`[refresh-exchange-rates] network error fetching base ${base}:`, fetchErr);
        continue;
      }

      if (!res.ok) {
        console.error(`[refresh-exchange-rates] fetch failed for base ${base}: HTTP ${res.status}`);
        continue;
      }

      const json = await res.json();
      if (json.result !== 'success' || !json.rates) {
        console.error(`[refresh-exchange-rates] unexpected payload for base ${base}:`, json.result);
        continue;
      }

      for (const target of SUPPORTED_CURRENCIES) {
        if (target === base) continue;
        const rate = json.rates[target];
        if (typeof rate !== 'number') {
          console.warn(`[refresh-exchange-rates] no rate for ${base}->${target}, skipping`);
          continue;
        }
        rows.push({ base_currency: base, target_currency: target, exchange_rate: rate, updated_at: now });
      }
    }

    if (!rows.length) {
      return new Response(JSON.stringify({ error: 'No rates could be fetched from the provider.' }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Clear out the pairs we're about to replace, then insert fresh
    // rows in one batch. Scoped to SUPPORTED_CURRENCIES so this never
    // touches rows for a currency pair outside what this run covers.
    const { error: deleteError } = await supabaseAdmin
      .from('exchange_rates')
      .delete()
      .in('base_currency', SUPPORTED_CURRENCIES);
    if (deleteError) throw deleteError;

    const { error: insertError } = await supabaseAdmin.from('exchange_rates').insert(rows);
    if (insertError) throw insertError;

    return new Response(JSON.stringify({ updated: rows.length, at: now }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[refresh-exchange-rates] error:', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});
