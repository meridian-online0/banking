/* =============================================================
   MERIDIAN — Internationalization (Better i18n edition)
   assets/js/i18n.js

   REPLACES the hand-rolled pipeline (locales/en.json,
   locales/i18n.config.json, scripts/i18n-sync.js) with Better i18n
   (https://better-i18n.com) as the translation platform. Delete
   those three files once this is wired up — this file no longer
   reads them.

   WHY NO SDK
   ----------
   Better i18n's official SDKs (@better-i18n/use-intl, @better-i18n/next,
   etc.) are React-only — there's no vanilla-JS package, and Meridian
   has no build step or framework. That's fine: per their own docs
   (docs.better-i18n.com/core/how-it-works), the CDN layer is just
   public JSON with open CORS (Access-Control-Allow-Origin: *) —
   no API key needed to READ translations, only to manage/publish
   them from the dashboard/CLI/API. So this file fetches the CDN
   directly, the same way it previously fetched local JSON — the
   data-i18n markup convention and the t()/setLanguage() functions
   are UNCHANGED, only where the bytes come from changed.

   BEFORE THIS WORKS, YOU NEED TO (see docs/i18n-setup.md):
     1. Create an org + project at dash.better-i18n.com
     2. Create two namespaces: "critical" and "general" (see the
        tier note below — this is how the old Tier A/B split maps
        onto Better i18n's data model)
     3. Import your existing key/value pairs (from the old en.json)
        via the CLI, or re-enter them in the dashboard
     4. Set PROJECT_ID below to your real "org/project" slug

   HOW TIER A / TIER B NOW WORKS — IMPORTANT BEHAVIOR CHANGE
   -------------------------------------------------------------
   The old i18n.js enforced "don't show an unreviewed Tier-A
   translation" IN CODE, by checking a `reviewed: true` flag on
   every lookup. Better i18n's public CDN has no such flag — it
   only ever serves whatever was most recently Published in the
   dashboard. There is no unpublished-but-fetchable state.

   That means the review gate has MOVED from this file into your
   dashboard workflow:
     - CRITICAL_NAMESPACES (below) should map to login/auth/error/
       legal/payment/checkout content — exactly the old Tier A.
     - Operational rule, not code: only click "Publish" on the
       critical namespace after a human has reviewed it in the
       dashboard. AI-drafted translations can sit unpublished
       indefinitely without risk — they're simply not fetchable
       until published.
     - general can be published as soon as an AI draft looks
       reasonable; that was always the Tier-B behavior.
   This file cannot enforce that discipline for you — flagging it
   clearly so it isn't quietly lost in the migration.

   KEY FORMAT
   ----------
   Keys are now "<namespace>.<path.into.that.namespace's.json>":

     <a data-i18n="general.nav.dashboard">Dashboard</a>
     <input data-i18n-attr="placeholder:critical.auth.login.email_label">

   The first dot-segment selects the namespace file
   ({locale}/{namespace}.json on the CDN); everything after that is
   a dot-path into that namespace's (possibly nested) JSON object —
   Better i18n's own translation files are nested by section
   (see their docs' en.json example: { "home": { "title": ... } }),
   unlike the old flat-dot-key en.json this file used to read.
   ============================================================= */

const CDN_BASE = 'https://cdn.better-i18n.com';

// Set this to your real "org/project" slug from dash.better-i18n.com
// — the placeholder below will 404 on every request until you do.
const PROJECT_ID = 'your-org/meridian';

// Must match the namespace names you create in the dashboard. Add
// more if you split further (e.g. a third "marketing" namespace
// for the public site) — nothing else in this file needs to change
// to support more namespaces, this array is the only place.
const NAMESPACES = ['critical', 'general'];

// For documentation/labeling only (e.g. a "needs extra care" note
// in an internal translations audit view) — NOT used to gate
// anything here anymore. See the big comment above.
const CRITICAL_NAMESPACES = ['critical'];

const STORAGE_KEY = 'meridian-lang';

let manifest = null;              // CDN manifest.json — { defaultLocale, locales, languages }
let englishByNamespace = {};      // fallback bundle, always loaded
let activeByNamespace = {};       // current language's bundles
let activeLang = null;

/* -----------------------------------------------------------
   CDN fetching
   ----------------------------------------------------------- */
async function fetchManifest() {
  const res = await fetch(`${CDN_BASE}/${PROJECT_ID}/manifest.json`);
  if (!res.ok) throw new Error(`Could not load Better i18n manifest (HTTP ${res.status}) for project "${PROJECT_ID}" — check PROJECT_ID in i18n.js.`);
  return res.json();
}

async function fetchNamespace(locale, namespace) {
  const res = await fetch(`${CDN_BASE}/${PROJECT_ID}/${locale}/${namespace}.json`);
  if (!res.ok) return null; // not translated for this locale yet, or namespace doesn't exist
  return res.json();
}

async function fetchAllNamespaces(locale) {
  const results = await Promise.all(NAMESPACES.map((ns) => fetchNamespace(locale, ns)));
  const bundle = {};
  NAMESPACES.forEach((ns, i) => { bundle[ns] = results[i] || {}; });
  return bundle;
}

/* -----------------------------------------------------------
   Language detection + switching
   ----------------------------------------------------------- */
function detectLanguage(availableLocales, fallback) {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && availableLocales.includes(stored)) return stored;
  } catch {
    // localStorage blocked — fall through.
  }

  const browserLangs = navigator.languages || [navigator.language].filter(Boolean);
  for (const tag of browserLangs) {
    const code = tag.split('-')[0].toLowerCase();
    if (availableLocales.includes(code)) return code;
  }

  return fallback;
}

/**
 * Switches the active language, fetches its namespace bundles if
 * needed, persists the choice, and re-applies translations.
 */
export async function setLanguage(lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Non-fatal.
  }

  activeByNamespace = lang === manifest.defaultLocale
    ? englishByNamespace
    : await fetchAllNamespaces(lang);

  activeLang = lang;
  document.documentElement.lang = lang;
  applyTranslations();
}

/**
 * Returns manifest.languages (code, name, nativeName, flagUrl) for
 * building a language switcher — see the reference implementation
 * at the bottom of this file.
 */
export function getAvailableLanguages() {
  return manifest?.languages || [];
}

export function getCurrentLanguage() {
  return activeLang;
}

/* -----------------------------------------------------------
   Key resolution — "<namespace>.<dot.path>"
   ----------------------------------------------------------- */
function getByPath(obj, path) {
  return path.split('.').reduce((node, segment) => (node && typeof node === 'object' ? node[segment] : undefined), obj);
}

function splitKey(key) {
  const [namespace, ...rest] = key.split('.');
  return { namespace, path: rest.join('.') };
}

function resolve(key) {
  const { namespace, path } = splitKey(key);
  if (!NAMESPACES.includes(namespace)) {
    console.warn(`[Meridian i18n] "${key}" doesn't start with a known namespace (${NAMESPACES.join(', ')}) — showing the raw key.`);
    return key;
  }

  const englishValue = getByPath(englishByNamespace[namespace], path);

  if (activeLang === manifest.defaultLocale) {
    return englishValue ?? key;
  }

  const translatedValue = getByPath(activeByNamespace[namespace], path);
  return translatedValue ?? englishValue ?? key;
}

/**
 * Direct lookup for page scripts — toasts, dynamically built rows,
 * or strings needing {placeholder} interpolation.
 */
export function t(key, params = {}) {
  let str = resolve(key);
  if (typeof str !== 'string') return key; // path resolved to an object/undefined, not a string leaf
  for (const [token, value] of Object.entries(params)) {
    str = str.replaceAll(`{${token}}`, value);
  }
  return str;
}

/* -----------------------------------------------------------
   DOM application — unchanged from the old file
   ----------------------------------------------------------- */
function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = resolve(el.dataset.i18n);
  });

  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split('|').forEach((pair) => {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, resolve(key));
    });
  });
}

/** Re-applies translations to a subtree after injecting new markup at runtime. */
export function translateSubtree(root) {
  applyTranslations(root);
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
export async function initI18n() {
  try {
    manifest = await fetchManifest();
  } catch (err) {
    console.error(`[Meridian i18n] ${err.message}`);
    return; // page renders with whatever static text is already in the HTML
  }

  englishByNamespace = await fetchAllNamespaces(manifest.defaultLocale);

  const lang = detectLanguage(manifest.locales, manifest.defaultLocale);
  await setLanguage(lang);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initI18n, { once: true });
} else {
  initI18n();
}

/* -----------------------------------------------------------
   Language switcher — minimal reference implementation.
   Call this after initI18n() has resolved (a page script wiring a
   switcher should await its own small delay or poll
   getCurrentLanguage() before building the <select> — kept as a
   plain function here rather than baking a ready-promise into this
   file, since not every page needs a switcher):

     import { getAvailableLanguages, setLanguage, getCurrentLanguage } from '../assets/js/i18n.js';

     function buildLanguageSwitcher(selectEl) {
       selectEl.innerHTML = getAvailableLanguages()
         .map((lang) => `<option value="${lang.code}">${lang.nativeName}</option>`)
         .join('');
       selectEl.value = getCurrentLanguage();
       selectEl.addEventListener('change', () => setLanguage(selectEl.value));
     }
   ----------------------------------------------------------- */
