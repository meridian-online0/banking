/* =============================================================
   MERIDIAN — Reset password page
   Script: pages/reset-password.js
   Loaded as a module by reset-password.html only. Handles:
     1. Detecting the Supabase recovery session created by the
        emailed link (via the PASSWORD_RECOVERY auth event)
     2. Show / hide password
     3. Field validation on submit
     4. Setting the new password + redirect to login

   This page does NOT use requireAuth() from auth.js — that guard
   is for already-authenticated app pages and would redirect a
   visitor with no ordinary session straight to login.html, which
   is exactly the wrong behavior here: a password-reset visitor is
   *supposed* to arrive with no normal session, only the special
   recovery one Supabase creates from the emailed link's token.
   ============================================================= */

import { supabase } from '../supabase/config.js';
import { updateUserPassword, onAuthStateChange } from '../supabase/auth.js';
import { ROUTES } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);

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
function $$(selector, scope) {
  return Array.from((scope || document).querySelectorAll(selector));
}

/**
 * Supabase's client library reads the recovery token out of the
 * URL fragment automatically on page load and fires a
 * PASSWORD_RECOVERY auth event once it's exchanged it for a real
 * (temporary) session. Until that fires — or unless a session
 * already exists when this runs — the form stays disabled, since
 * calling updateUser() without a recovery session would just fail.
 */
function waitForRecoverySession() {
  return new Promise((resolve) => {
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) {
        resolve(true);
        return;
      }
      const sub = onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') {
          sub.unsubscribe();
          resolve(true);
        }
      });
      // If no recovery event arrives at all (bad/expired/reused
      // link), stop waiting after a few seconds rather than leaving
      // the visitor staring at a disabled form forever.
      setTimeout(() => resolve(false), 6000);
    });
  });
}

function initResetForm() {
  const form = $('#reset-password-form');
  if (!form) return;

  const newPasswordField = $('#reset-new-password');
  const confirmField = $('#reset-confirm-password');
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

    const { error } = await updateUserPassword(newPasswordField.value);

    submitBtn.classList.remove('is-loading');
    submitBtn.disabled = false;

    if (error) {
      showAlert(alertBox, error, 'error');
      return;
    }

    showAlert(alertBox, 'Your password has been reset. Redirecting to login\u2026', 'success');
    form.reset();
    await supabase.auth.signOut(); // don't leave the recovery session active
    setTimeout(() => { window.location.href = 'login.html'; }, 1500);
  });
}

(async function init() {
  const form = $('#reset-password-form');
  const alertBox = $('.auth-form-alert');
  const submitBtn = form ? $('.auth-submit-btn', form) : null;

  if (submitBtn) submitBtn.disabled = true;

  initPasswordToggles();
  initResetForm();

  const ready = await waitForRecoverySession();

  if (!ready) {
    showAlert(alertBox, 'This password reset link is invalid or has expired. Request a new one from the login page.', 'error');
    if (form) form.hidden = true;
    return;
  }

  if (submitBtn) submitBtn.disabled = false;
})();
