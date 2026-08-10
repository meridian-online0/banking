/* =============================================================
   MERIDIAN — Login page
   Script: pages/login.js
   Loaded as a module by login.html only. Handles:
     1. Show / hide password
     2. Field validation on submit
     3. Real Supabase sign-in + submit spinner
     4. Dead-end links (forgot password, verification methods)
   ============================================================= */

import { signInUser, redirectIfAuthenticated, requestPasswordReset } from '../supabase/auth.js';
import { ROUTES } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);

function showAlert(alertBox, message, tone = 'error') {
  if (!alertBox) return;
  const text = $('.auth-form-alert-text', alertBox);
  if (text) text.textContent = message;
  alertBox.hidden = false;
  // Belt-and-suspenders: force visibility with inline style too, in case
  // author CSS (e.g. `.auth-form-alert { display:flex }`) overrides the
  // browser's default `[hidden]{display:none}` rule.
  alertBox.style.display = 'flex';
  alertBox.classList.toggle('auth-form-alert--success', tone === 'success');
}

function hideAlert(alertBox) {
  if (!alertBox) return;
  alertBox.hidden = true;
  alertBox.style.display = 'none';
  alertBox.classList.remove('auth-form-alert--success');
}

function initPasswordToggle() {
  const toggle = $('.password-toggle');
  const input = $('#login-password');
  if (!toggle || !input) return;

  toggle.addEventListener('click', () => {
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(isHidden));
    toggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
  });
}

function initLoginForm() {
  const form = $('#login-form');
  if (!form) return;

  const emailField = $('#login-email');
  const passwordField = $('#login-password');
  const alertBox = $('.auth-form-alert');
  const submitBtn = $('.auth-submit-btn', form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideAlert(alertBox);

    // Validate the two visible fields directly rather than form.checkValidity(),
    // so the error points at the field and works the same regardless of layout.
    if (!emailField.checkValidity()) {
      emailField.reportValidity();
      return;
    }
    if (!passwordField.checkValidity()) {
      passwordField.reportValidity();
      return;
    }

    if (submitBtn) {
      submitBtn.classList.add('is-loading');
      submitBtn.disabled = true;
    }

    try {
      const { data, error } = await signInUser(emailField.value.trim(), passwordField.value);

      if (error) {
        showAlert(alertBox, error, 'error');
        return;
      }

      if (!data?.user) {
        showAlert(alertBox, 'Something went wrong signing you in. Please try again.', 'error');
        return;
      }

      showAlert(alertBox, 'Welcome back — redirecting to your dashboard.', 'success');
      window.setTimeout(() => {
        window.location.href = ROUTES.dashboard;
      }, 800);
    } catch (err) {
      showAlert(alertBox, 'We could not reach Supabase. Check your connection and try again.', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.classList.remove('is-loading');
        submitBtn.disabled = false;
      }
    }
  });
}

function initDeadEndLinks() {
  const alertBox = $('.auth-form-alert');
  const forgotLink = $('.auth-forgot-link');
  const methodButtons = document.querySelectorAll('.auth-method-btn');


   if (forgotLink) {
    forgotLink.addEventListener('click', async (event) => {
      event.preventDefault();

      const emailField = $('#login-email');
      const email = emailField?.value.trim();

      if (!email) {
        showAlert(alertBox, 'Enter your email address above first, then click "Forgot password?" again.', 'error');
        emailField?.focus();
        return;
      }
      if (!emailField.checkValidity()) {
        showAlert(alertBox, 'That doesn\u2019t look like a valid email address.', 'error');
        emailField.focus();
        return;
      }

      forgotLink.classList.add('is-loading');
      const { error } = await requestPasswordReset(email);
      forgotLink.classList.remove('is-loading');

      // Deliberately the same message whether or not the email
      // exists in the system — confirming/denying an email's
      // existence here would let someone enumerate registered
      // accounts by trying addresses one at a time.
      showAlert(
        alertBox,
        `If an account exists for ${email}, we've sent a link to reset your password.`,
        'success'
      );
    });
  }

  methodButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const method = btn.getAttribute('data-method') === 'authenticator' ? 'an authenticator app' : 'an email code';
      showAlert(alertBox, `Verification via ${method} isn't available yet.`, 'error');
    });
  });
}

redirectIfAuthenticated();

initPasswordToggle();
initLoginForm();
initDeadEndLinks();
