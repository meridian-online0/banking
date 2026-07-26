/* =============================================================
   MERIDIAN — International Digital Banking
   Script: assets/js/main.js
   Contents:
     1. Utilities
     2. Sticky header shadow on scroll
     3. Mobile navigation drawer
     4. FAQ accordion
     5. Exchange rate data + ticker duplication
     6. Currency converter
     7. Statistics counter animation
     8. Testimonial carousel
     9. Scroll-reveal (IntersectionObserver)
     10. Back-to-top button
     11. Contact form validation
     12. Newsletter form
     13. Footer year
     14. Chat support widget
   ============================================================= */

(function () {
  'use strict';

  /* -----------------------------------------------------------
     1. Utilities
     ----------------------------------------------------------- */
  const $ = (selector, scope) => (scope || document).querySelector(selector);
  const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -----------------------------------------------------------
     2. Sticky header shadow on scroll
     ----------------------------------------------------------- */
  function initHeaderScroll() {
    const header = $('.site-header');
    if (!header) return;

    const applyState = () => {
      if (window.scrollY > 8) {
        header.classList.add('is-scrolled');
      } else {
        header.classList.remove('is-scrolled');
      }
    };

    applyState();
    window.addEventListener('scroll', applyState, { passive: true });
  }

  /* -----------------------------------------------------------
     3. Mobile navigation drawer
     ----------------------------------------------------------- */
  function initMobileNav() {
    const toggle = $('.nav-toggle');
    const drawer = $('.mobile-drawer');
    const closeBtn = $('.mobile-drawer-close');
    if (!toggle || !drawer) return;

    const links = $$('a', drawer);

    const openDrawer = () => {
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.classList.add('drawer-open');
      const firstLink = links[0];
      if (firstLink) firstLink.focus({ preventScroll: true });
    };

    const closeDrawer = () => {
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('drawer-open');
      toggle.focus({ preventScroll: true });
    };

    toggle.addEventListener('click', () => {
      const isOpen = drawer.classList.contains('is-open');
      isOpen ? closeDrawer() : openDrawer();
    });

    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

    links.forEach((link) => link.addEventListener('click', closeDrawer));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
        closeDrawer();
      }
    });

    // simple focus trap while the drawer is open
    drawer.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = $$('a, button', drawer).filter((el) => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  /* -----------------------------------------------------------
     4. FAQ accordion
     ----------------------------------------------------------- */
  function initFaqAccordion() {
    const items = $$('.faq-item');
    if (!items.length) return;

    items.forEach((item) => {
      const question = $('.faq-question', item);
      const answer = $('.faq-answer', item);
      if (!question || !answer) return;

      question.addEventListener('click', () => {
        const isOpen = item.classList.contains('is-open');

        // close any other open item for a clean single-open accordion
        items.forEach((other) => {
          if (other !== item) {
            other.classList.remove('is-open');
            $('.faq-question', other).setAttribute('aria-expanded', 'false');
            $('.faq-answer', other).style.maxHeight = null;
          }
        });

        if (isOpen) {
          item.classList.remove('is-open');
          question.setAttribute('aria-expanded', 'false');
          answer.style.maxHeight = null;
        } else {
          item.classList.add('is-open');
          question.setAttribute('aria-expanded', 'true');
          answer.style.maxHeight = answer.scrollHeight + 'px';
        }
      });
    });

    // keep open panel height correct if the viewport is resized
    window.addEventListener('resize', () => {
      const openItem = items.find((item) => item.classList.contains('is-open'));
      if (!openItem) return;
      const answer = $('.faq-answer', openItem);
      answer.style.maxHeight = answer.scrollHeight + 'px';
    });
  }

  /* -----------------------------------------------------------
     5. Exchange rate data + ticker duplication
     ----------------------------------------------------------- */
  // Static illustrative rates, quoted against 1 USD.
  const RATES = {
    USD: { rate: 1, name: 'US Dollar' },
    EUR: { rate: 0.92, name: 'Euro' },
    GBP: { rate: 0.79, name: 'British Pound' },
    JPY: { rate: 156.24, name: 'Japanese Yen' },
    CHF: { rate: 0.89, name: 'Swiss Franc' },
    CNY: { rate: 7.24, name: 'Chinese Yuan' },
    AUD: { rate: 1.52, name: 'Australian Dollar' },
    CAD: { rate: 1.37, name: 'Canadian Dollar' },
    SGD: { rate: 1.34, name: 'Singapore Dollar' },
    AED: { rate: 3.67, name: 'UAE Dirham' },
    NGN: { rate: 1548.5, name: 'Nigerian Naira' },
    INR: { rate: 83.4, name: 'Indian Rupee' }
  };

  const TICKER_DELTAS = [
    { pair: 'EUR / USD', value: '0.9214', change: '+0.18%', up: true },
    { pair: 'GBP / USD', value: '0.7891', change: '-0.06%', up: false },
    { pair: 'USD / JPY', value: '156.24', change: '+0.24%', up: true },
    { pair: 'USD / CHF', value: '0.8863', change: '-0.11%', up: false },
    { pair: 'USD / CNY', value: '7.2381', change: '+0.05%', up: true },
    { pair: 'AUD / USD', value: '0.6584', change: '+0.32%', up: true },
    { pair: 'USD / CAD', value: '1.3742', change: '-0.09%', up: false },
    { pair: 'USD / SGD', value: '1.3405', change: '+0.14%', up: true },
    { pair: 'USD / AED', value: '3.6725', change: '0.00%', up: true },
    { pair: 'USD / INR', value: '83.41', change: '+0.07%', up: true }
  ];

  const upArrow = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const downArrow = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 2v8M6 10l3.5-3.5M6 10 2.5 6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function buildTickerMarkup() {
    return TICKER_DELTAS.map((item) => `
      <div class="ticker-item">
        <span class="pair">${item.pair}</span>
        <span>${item.value}</span>
        <span class="delta ${item.up ? 'up' : 'down'}">
          ${item.up ? upArrow : downArrow}${item.change}
        </span>
      </div>
    `).join('');
  }

  function initTicker() {
    const track = $('.ticker-track');
    if (!track) return;
    // duplicate the sequence once so the CSS keyframe (-50%) loops seamlessly
    const markup = buildTickerMarkup();
    track.innerHTML = markup + markup;
    track.setAttribute('aria-hidden', 'true');
  }

  /* -----------------------------------------------------------
     6. Currency converter
     ----------------------------------------------------------- */
  function initConverter() {
    const amountInput = $('#converter-amount');
    const fromSelect = $('#converter-from');
    const toSelect = $('#converter-to');
    const swapBtn = $('.converter-swap');
    const resultValue = $('.result-value');
    const rateNote = $('.rate-note');
    if (!amountInput || !fromSelect || !toSelect || !resultValue) return;

    function formatNumber(value) {
      return value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    }

    function convert() {
      const amount = parseFloat(amountInput.value) || 0;
      const from = RATES[fromSelect.value];
      const to = RATES[toSelect.value];
      if (!from || !to) return;

      const usdAmount = amount / from.rate;
      const converted = usdAmount * to.rate;
      resultValue.textContent = `${formatNumber(converted)} ${toSelect.value}`;

      const unitRate = to.rate / from.rate;
      if (rateNote) {
        rateNote.textContent = `1 ${fromSelect.value} = ${unitRate.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${toSelect.value} · mid-market rate, no markup`;
      }
    }

    amountInput.addEventListener('input', convert);
    fromSelect.addEventListener('change', convert);
    toSelect.addEventListener('change', convert);

    if (swapBtn) {
      swapBtn.addEventListener('click', () => {
        const temp = fromSelect.value;
        fromSelect.value = toSelect.value;
        toSelect.value = temp;
        convert();
      });
    }

    convert();
  }

  /* -----------------------------------------------------------
     7. Statistics counter animation
     ----------------------------------------------------------- */
  function initCounters() {
    const counters = $$('.stat-number[data-target]');
    if (!counters.length) return;

    const animateCounter = (el) => {
      const target = parseFloat(el.getAttribute('data-target'));
      const decimals = parseInt(el.getAttribute('data-decimals') || '0', 10);
      const duration = 1800;
      const start = performance.now();

      if (prefersReducedMotion) {
        el.querySelector('.value').textContent = target.toFixed(decimals);
        return;
      }

      function tick(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
        const current = target * eased;
        el.querySelector('.value').textContent = current.toFixed(decimals);
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          el.querySelector('.value').textContent = target.toFixed(decimals);
        }
      }
      requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          animateCounter(entry.target);
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach((counter) => observer.observe(counter));
  }

  /* -----------------------------------------------------------
     8. Testimonial carousel
     ----------------------------------------------------------- */
  function initTestimonialCarousel() {
    const viewport = $('.testimonial-viewport');
    const track = $('.testimonial-track');
    const prevBtn = $('.carousel-btn--prev');
    const nextBtn = $('.carousel-btn--next');
    const dotsWrap = $('.carousel-dots');
    if (!viewport || !track) return;

    const cards = $$('.testimonial-card', track);
    let cardsPerView = getCardsPerView();
    let index = 0;
    let autoplayTimer = null;

    function getCardsPerView() {
      const width = window.innerWidth;
      if (width <= 720) return 1;
      if (width <= 980) return 2;
      return 3;
    }

    function maxIndex() {
      return Math.max(0, cards.length - cardsPerView);
    }

    function renderDots() {
      if (!dotsWrap) return;
      dotsWrap.innerHTML = '';
      const dotCount = maxIndex() + 1;
      for (let i = 0; i < dotCount; i += 1) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', `Show testimonial group ${i + 1}`);
        if (i === index) dot.classList.add('is-active');
        dot.addEventListener('click', () => goTo(i));
        dotsWrap.appendChild(dot);
      }
    }

    function update() {
      const cardWidth = cards[0] ? cards[0].getBoundingClientRect().width : 0;
      const gap = 28; // matches --gap used in CSS (1.75rem)
      track.style.transform = `translateX(-${index * (cardWidth + gap)}px)`;
      if (dotsWrap) {
        $$('button', dotsWrap).forEach((dot, i) => dot.classList.toggle('is-active', i === index));
      }
    }

    function goTo(newIndex) {
      index = Math.min(Math.max(newIndex, 0), maxIndex());
      update();
    }

    function next() {
      index = index >= maxIndex() ? 0 : index + 1;
      update();
    }

    function prev() {
      index = index <= 0 ? maxIndex() : index - 1;
      update();
    }

    function startAutoplay() {
      if (prefersReducedMotion) return;
      stopAutoplay();
      autoplayTimer = window.setInterval(next, 6000);
    }

    function stopAutoplay() {
      if (autoplayTimer) window.clearInterval(autoplayTimer);
    }

    if (nextBtn) nextBtn.addEventListener('click', () => { next(); stopAutoplay(); startAutoplay(); });
    if (prevBtn) prevBtn.addEventListener('click', () => { prev(); stopAutoplay(); startAutoplay(); });

    viewport.addEventListener('mouseenter', stopAutoplay);
    viewport.addEventListener('mouseleave', startAutoplay);
    viewport.addEventListener('focusin', stopAutoplay);
    viewport.addEventListener('focusout', startAutoplay);

    window.addEventListener('resize', () => {
      cardsPerView = getCardsPerView();
      index = Math.min(index, maxIndex());
      renderDots();
      update();
    });

    renderDots();
    update();
    startAutoplay();
  }

  /* -----------------------------------------------------------
     9. Scroll-reveal (IntersectionObserver)
     ----------------------------------------------------------- */
  function initScrollReveal() {
    const targets = $$('[data-reveal], [data-reveal-stagger]');
    if (!targets.length) return;

    if (prefersReducedMotion) {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

    targets.forEach((el) => observer.observe(el));
  }

  /* -----------------------------------------------------------
     10. Back-to-top button
     ----------------------------------------------------------- */
  function initBackToTop() {
    const btn = $('.back-to-top');
    if (!btn) return;

    const applyState = () => {
      btn.classList.toggle('is-visible', window.scrollY > 700);
    };

    applyState();
    window.addEventListener('scroll', applyState, { passive: true });

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    });
  }

  /* -----------------------------------------------------------
     11. Contact form validation
     ----------------------------------------------------------- */
  function initContactForm() {
    const form = $('#contact-form');
    if (!form) return;
    const successPanel = $('.form-success');

    function setError(field, message) {
      field.classList.toggle('has-error', Boolean(message));
      const errorEl = $('.field-error', field);
      if (errorEl) errorEl.textContent = message || '';
    }

    function isValidEmail(value) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      let valid = true;

      const nameField = $('#field-name').closest('.field');
      const emailField = $('#field-email').closest('.field');
      const subjectField = $('#field-subject').closest('.field');
      const messageField = $('#field-message').closest('.field');

      const nameVal = $('#field-name').value.trim();
      const emailVal = $('#field-email').value.trim();
      const subjectVal = $('#field-subject').value.trim();
      const messageVal = $('#field-message').value.trim();

      if (!nameVal) {
        setError(nameField, 'Please enter your full name.');
        valid = false;
      } else {
        setError(nameField, '');
      }

      if (!emailVal || !isValidEmail(emailVal)) {
        setError(emailField, 'Please enter a valid email address.');
        valid = false;
      } else {
        setError(emailField, '');
      }

      if (!subjectVal) {
        setError(subjectField, 'Please choose a topic.');
        valid = false;
      } else {
        setError(subjectField, '');
      }

      if (!messageVal || messageVal.length < 10) {
        setError(messageField, 'Please add a little more detail (10+ characters).');
        valid = false;
      } else {
        setError(messageField, '');
      }

      if (!valid) {
        const firstError = $('.field.has-error', form);
        if (firstError) $('input, select, textarea', firstError).focus();
        return;
      }

      form.classList.add('is-hidden');
      if (successPanel) {
        successPanel.classList.add('is-visible');
        successPanel.setAttribute('tabindex', '-1');
        successPanel.focus();
      }
    });
  }

  /* -----------------------------------------------------------
     12. Newsletter form
     ----------------------------------------------------------- */
  function initNewsletterForm() {
    const form = $('.newsletter-form');
    if (!form) return;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('input', form);
      const note = $('.newsletter-note', form.parentElement);
      if (!input || !input.value.trim()) return;

      if (note) {
        note.textContent = 'You are subscribed. Thank you for joining Meridian.';
      }
      input.value = '';
    });
  }

  /* -----------------------------------------------------------
     13. Footer year
     ----------------------------------------------------------- */
  function initFooterYear() {
    const el = $('#footer-year');
    if (el) el.textContent = new Date().getFullYear();
  }

  /* -----------------------------------------------------------
     14. Chat support widget
     ----------------------------------------------------------- */
  function initChatWidget() {
    const widget = $('#chat-widget');
    const launcher = $('#chat-launcher');
    const badge = $('#chat-launcher-badge');
    const panel = $('#chat-panel');
    const closeBtn = $('#chat-close');
    const body = $('#chat-body');
    const typingIndicator = $('#chat-typing');
    const inputForm = $('#chat-input-row');
    const input = $('#chat-input');
    const quickReplies = $('#chat-quick-replies');

    const menuToggle = $('#chat-menu-toggle');
    const menu = $('#chat-menu');
    const soundToggle = $('#chat-sound-toggle');
    const downloadBtn = $('#chat-download-transcript');
    const a11yToggle = $('#chat-accessibility-toggle');
    const a11ySubmenu = $('#chat-accessibility-submenu');
    const largeTextCheck = $('#chat-large-text');
    const highContrastCheck = $('#chat-high-contrast');
    const reduceMotionCheck = $('#chat-reduce-motion');
    const privacyToggle = $('#chat-privacy-toggle');
    const privacySubmenu = $('#chat-privacy-submenu');
    const requestDataBtn = $('#chat-request-data');
    const deleteDataBtn = $('#chat-delete-data');
    const clearBtn = $('#chat-clear-conversation');

    if (!widget || !launcher || !panel) return;

    let soundEnabled = true;
    let audioCtx = null;
    const transcript = [];

    /* ---------- helpers ---------- */

    function timeNow() {
      return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }

    function playChime() {
      if (!soundEnabled || prefersReducedMotion) return;
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1180, audioCtx.currentTime + 0.09);
        gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.32);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.34);
      } catch (err) {
        /* Web Audio unavailable — fail silently, sound is a nicety */
      }
    }

    function appendMessage(text, from) {
      const row = document.createElement('div');
      row.className = `chat-msg chat-msg--${from}`;
      const time = timeNow();

      if (from === 'bot') {
        row.innerHTML = `
          <span class="chat-msg-avatar">M</span>
          <div class="chat-bubble"><p></p><span class="chat-msg-time"></span></div>
        `;
      } else {
        row.innerHTML = `
          <div class="chat-bubble"><p></p><span class="chat-msg-time"></span></div>
        `;
      }
      $('p', row).textContent = text;
      $('.chat-msg-time', row).textContent = time;
      body.appendChild(row);
      body.scrollTop = body.scrollHeight;
      transcript.push({ from, text, time });
    }

    function showTyping() {
      if (typingIndicator) typingIndicator.classList.add('is-visible');
      body.scrollTop = body.scrollHeight;
    }

    function hideTyping() {
      if (typingIndicator) typingIndicator.classList.remove('is-visible');
    }

    const BOT_REPLIES = [
      "Thanks for the detail — a member of our support team will pick this up shortly. In the meantime, is there anything else I can check for you?",
      "Got it. I've noted that down. Most questions like this are resolved within a few minutes during business hours.",
      "Understood. You can also track this in your dashboard under Support once you're logged in."
    ];
    let replyIndex = 0;

    function simulateBotReply() {
      showTyping();
      const delay = 900 + Math.random() * 700;
      window.setTimeout(() => {
        hideTyping();
        const reply = BOT_REPLIES[replyIndex % BOT_REPLIES.length];
        replyIndex += 1;
        appendMessage(reply, 'bot');
        playChime();
      }, delay);
    }

    function sendUserMessage(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      appendMessage(trimmed, 'user');
      if (quickReplies) quickReplies.remove();
      simulateBotReply();
    }

    /* ---------- open / close panel ---------- */

    function openChat() {
      widget.classList.add('is-open');
      launcher.setAttribute('aria-expanded', 'true');
      panel.setAttribute('aria-hidden', 'false');
      if (badge) badge.classList.add('is-hidden');
      window.setTimeout(() => input && input.focus(), 150);
    }

    function closeChat() {
      widget.classList.remove('is-open');
      launcher.setAttribute('aria-expanded', 'false');
      panel.setAttribute('aria-hidden', 'true');
      closeMenu();
      launcher.focus();
    }

    launcher.addEventListener('click', () => {
      widget.classList.contains('is-open') ? closeChat() : openChat();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeChat);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (menu && menu.classList.contains('is-open')) {
        closeMenu();
        return;
      }
      if (widget.classList.contains('is-open')) closeChat();
    });

    /* ---------- quick replies + input ---------- */

    if (quickReplies) {
      $$('.chat-quick-reply', quickReplies).forEach((btn) => {
        btn.addEventListener('click', () => sendUserMessage(btn.getAttribute('data-reply') || btn.textContent));
      });
    }

    if (inputForm && input) {
      inputForm.addEventListener('submit', (event) => {
        event.preventDefault();
        sendUserMessage(input.value);
        input.value = '';
        input.style.height = 'auto';
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          inputForm.requestSubmit();
        }
      });

      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
      });
    }

    /* ---------- three-dot options menu ---------- */

    function openMenu() {
      menu.classList.add('is-open');
      menu.setAttribute('aria-hidden', 'false');
      menuToggle.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
      if (!menu) return;
      menu.classList.remove('is-open');
      menu.setAttribute('aria-hidden', 'true');
      menuToggle.setAttribute('aria-expanded', 'false');
      closeSubmenu(a11ySubmenu, a11yToggle);
      closeSubmenu(privacySubmenu, privacyToggle);
    }

    function closeSubmenu(submenu, toggle) {
      if (!submenu) return;
      submenu.classList.remove('is-open');
      submenu.setAttribute('aria-hidden', 'true');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }

    function toggleSubmenu(submenu, toggle) {
      if (!submenu) return;
      const isOpen = submenu.classList.contains('is-open');
      // close the other submenu first, keep menu open
      closeSubmenu(a11ySubmenu, a11yToggle);
      closeSubmenu(privacySubmenu, privacyToggle);
      if (!isOpen) {
        submenu.classList.add('is-open');
        submenu.setAttribute('aria-hidden', 'false');
        if (toggle) toggle.setAttribute('aria-expanded', 'true');
      }
    }

    if (menuToggle && menu) {
      menuToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        menu.classList.contains('is-open') ? closeMenu() : openMenu();
      });

      document.addEventListener('click', (event) => {
        if (!menu.classList.contains('is-open')) return;
        if (menu.contains(event.target) || menuToggle.contains(event.target)) return;
        closeMenu();
      });
    }

    /* ---------- play sound toggle ---------- */

    if (soundToggle) {
      soundToggle.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        soundToggle.setAttribute('aria-checked', String(soundEnabled));
        const stateEl = $('.chat-menu-item-state', soundToggle);
        if (stateEl) {
          stateEl.textContent = soundEnabled ? 'On' : 'Off';
          stateEl.setAttribute('data-state', soundEnabled ? 'on' : 'off');
        }
        if (soundEnabled) playChime();
      });
    }

    /* ---------- download transcript ---------- */

    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        const lines = transcript.length
          ? transcript.map((m) => `[${m.time}] ${m.from === 'bot' ? 'Meridian Support' : 'You'}: ${m.text}`)
          : ['[No messages yet]'];
        const header = `Meridian Support — chat transcript\nDownloaded ${new Date().toLocaleString()}\n${'-'.repeat(40)}\n`;
        const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meridian-chat-transcript-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        closeMenu();
      });
    }

    /* ---------- accessibility submenu ---------- */

    if (a11yToggle) {
      a11yToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSubmenu(a11ySubmenu, a11yToggle);
      });
    }

    if (largeTextCheck) {
      largeTextCheck.addEventListener('change', () => {
        document.body.classList.toggle('a11y-large-text', largeTextCheck.checked);
      });
    }

    if (highContrastCheck) {
      highContrastCheck.addEventListener('change', () => {
        document.body.classList.toggle('a11y-high-contrast', highContrastCheck.checked);
      });
    }

    if (reduceMotionCheck) {
      reduceMotionCheck.addEventListener('change', () => {
        document.documentElement.classList.toggle('a11y-reduce-motion', reduceMotionCheck.checked);
      });
    }

    /* ---------- privacy & GDPR submenu ---------- */

    if (privacyToggle) {
      privacyToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSubmenu(privacySubmenu, privacyToggle);
      });
    }

    if (requestDataBtn) {
      requestDataBtn.addEventListener('click', () => {
        closeMenu();
        appendMessage("You requested a copy of your chat data. We'll email a summary to the address on file within 30 days, per GDPR Article 15.", 'bot');
        playChime();
      });
    }

    if (deleteDataBtn) {
      deleteDataBtn.addEventListener('click', () => {
        closeMenu();
        appendMessage("Your deletion request has been logged. This conversation's data will be permanently removed within 30 days, per GDPR Article 17.", 'bot');
        playChime();
      });
    }

    /* ---------- clear conversation ---------- */

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        closeMenu();
        transcript.length = 0;
        body.innerHTML = '';
        replyIndex = 0;
        const dayDivider = document.createElement('div');
        dayDivider.className = 'chat-day-divider';
        dayDivider.innerHTML = '<span>Today</span>';
        body.appendChild(dayDivider);
        appendMessage("Conversation cleared. What can I help you with?", 'bot');
      });
    }
  }

  /* -----------------------------------------------------------
     Init
     ----------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    initHeaderScroll();
    initMobileNav();
    initFaqAccordion();
    initTicker();
    initConverter();
    initCounters();
    initTestimonialCarousel();
    initScrollReveal();
    initBackToTop();
    initContactForm();
    initNewsletterForm();
    initFooterYear();
    initChatWidget();
  });
})();
