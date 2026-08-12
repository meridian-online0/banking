/* =============================================================
   MERIDIAN — Forced password reset page
   Script: pages/force-password-reset.js
   Loaded as a module by force-password-reset.html only.

   Unlike reset-password.js (the emailed-recovery-link flow, which
   deliberately skips requireAuth() because a recovery visitor has
   no ordinary session), this page IS gated by requireAuth() — the
   visitor already has a normal session, and requireAuth() itself
   is what routes them here in the first place whenever
   user_profiles.must_reset_password is true. See auth.js's
   requireAuth() for the redirect logic; this page just needs to
   let itself through when it IS the current page (requireAuth()
   already special-cases that).
   ============================================================= */

import { requireAuth, completeForcedPasswordReset } from '../supabase/auth.js';
import { ROUTES } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

function showAlert(alertBox, message, tone = 'error') {
  if (!alertBox) return;
  const text = $('.auth-form-alert-text', alertBox);
  if (text) text.textContent = message;
  alertBox.hidden = false;
  alertBox.style.display = 'flex';
  alertBox.classList.toggle('auth-form-alert--success', tone === 'success');
}

function hideAlert(alertBox) {
  if (!alertBox) return;
  alertBox.hidden = true;
  alertBox.style.display = 'none';
  alertBox.classList.remove('auth-form-alert--success');
}

function initPasswordToggles() {
  $$('.password-toggle').forEach((toggle) => {
    const input = toggle.closest('.password-field-wrap')?.querySelector('input');
    if (!input) return;
    toggle.addEventListener('click', () => {
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(isHidden));
      toggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
  });
}

function initForm() {
  const form = $('#force-reset-form');
  if (!form) return;

  const newPasswordField = $('#force-new-password');
  const confirmField = $('#force-confirm-password');
  const alertBox = $('.auth-form-alert');
  const submitBtn = $('.auth-submit-btn', form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert(alertBox);

    if (!newPasswordField.checkValidity()) {
      newPasswordField.reportValidity();
      return;
    }
    if (newPasswordField.value.length < 10) {
      showAlert(alertBox, 'Use at least 10 characters.', 'error');
      newPasswordField.focus();
      return;
    }
    if (newPasswordField.value !== confirmField.value) {
      showAlert(alertBox, 'Passwords don\u2019t match.', 'error');
      confirmField.focus();
      return;
    }

    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;

    const { error } = await completeForcedPasswordReset(newPasswordField.value);

    submitBtn.classList.remove('is-loading');
    submitBtn.disabled = false;

    if (error) {
      showAlert(alertBox, error, 'error');
      return;
    }

    showAlert(alertBox, 'Password updated. Redirecting\u2026', 'success');
    form.reset();
    setTimeout(() => { window.location.href = ROUTES.dashboard; }, 1200);
  });
}

(async function init() {
  // requireAuth() reveals the page (removes auth-pending) once it
  // confirms a real session — same as every other authenticated
  // page. It's also the thing that sent the visitor here, via its
  // must_reset_password check, so no extra guard is needed beyond
  // calling it normally.
  const user = await requireAuth();
  if (!user) return;

  initPasswordToggles();
  initForm();
})();
