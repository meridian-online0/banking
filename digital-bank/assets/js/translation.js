/* =============================================================
   MERIDIAN — International Digital Banking
   Script: assets/js/translation.js

   Local (no backend) translation engine. Loaded on every page,
   right after main.js. Responsibilities:

     1. Resolve which language to show, in this priority order:
          a) the logged-in user's saved user_profiles.language
             (pages call setLanguage() with it once their own
             profile fetch resolves — this file has no auth
             access itself)
          b) a language the visitor already explicitly chose on
             this browser (localStorage)
          c) IP-based geolocation on a first-ever visit only,
             mapped country -> language (never overrides an
             explicit choice, and only for countries where that
             language is the primary/official one)
          d) the browser's own language setting (navigator.language)
          e) English — the hard default if nothing else resolves

     2. Apply the resolved language to the DOM: every element
        carrying data-i18n / data-i18n-placeholder /
        data-i18n-aria-label / data-i18n-title gets its text (or
        the relevant attribute) set from the dictionary below.

     3. Flip document.documentElement.dir to "rtl" for Arabic,
        "ltr" for everything else.

   USAGE ON A PAGE
   -----------------------------------------------------------
   <script src="../assets/js/main.js"></script>
   <script src="../assets/js/translation.js"></script>

   translation.js self-initializes on DOMContentLoaded using
   localStorage/geo/browser detection (steps b–e above) so pages
   render in the right language immediately, before any auth call
   resolves. Once a page's own script knows the logged-in user's
   saved preference (from getMyProfile()), it should call:

     window.MeridianI18n.setLanguage(profile.language, { persist: false });

   ("persist: false" because the value is already the source of
   truth from the DB — no need to write it back to localStorage
   as if it were a fresh manual choice, though it's harmless
   either way.)

   settings.js is the only page expected to WRITE a new
   preference — see its own comment for how it calls
   setLanguage(code, { persist: true }) and then updateMyProfile().

   INJECTED COMPONENTS — IMPORTANT
   -----------------------------------------------------------
   components/app-navbar.html and components/chat-widget.html are
   both loaded ASYNCHRONOUSLY by components.js / chat-widget.js
   AFTER this file's own DOMContentLoaded init() has already run
   and already applied translations once. Their data-i18n markup
   will sit untranslated unless the code that injects them also
   calls:

     if (window.MeridianI18n) window.MeridianI18n.applyTranslations();

   right after injection completes — same spot notifications.js's
   boot call already lives for app-navbar, and the equivalent spot
   in chat-widget.js's mountChatWidget() for the chat panel. This
   is not yet wired into either components.js or chat-widget.js —
   flagging it here so it isn't missed when those files are next
   touched.

   ADDING TRANSLATABLE MARKUP
   -----------------------------------------------------------
   <h1 data-i18n="dashboard.greeting_fallback">Overview</h1>
   <input data-i18n-placeholder="common.search_placeholder" placeholder="Search">
   <button data-i18n-aria-label="common.close" aria-label="Close">...</button>

   The element's existing text/attribute is left as the English
   fallback in the HTML source itself (so the page still reads
   correctly if this script fails to load) — applyTranslations()
   overwrites it once a language resolves.

   Elements with NESTED markup (e.g. a <p> containing an <a>) must
   NOT carry data-i18n directly on the parent — applyTranslations()
   sets textContent, which silently deletes any child elements.
   Split into separate text-only spans instead, each with its own
   data-i18n key (see chat-widget.html's privacy-note paragraph for
   the pattern: pre-link span, the <a> itself, post-link span).

   KEY NAMESPACES SHIPPED SO FAR
   -----------------------------------------------------------
   common.*     — shared nav, header, notification dropdown, buttons
                  (used across every page + the app-navbar component)
   dashboard.*  — dashboard.html (fully wired)
   chat.*       — components/chat-widget.html (fully wired)

   More namespaces (accounts.*, transactions.*, transfer.*,
   cards.*, profile.*, settings.*, statements.*) get added here
   as each page is wired with data-i18n, one at a time, per the
   project's own convention of one script/concern at a time.
   ============================================================= */

(function () {
  'use strict';

  /* -----------------------------------------------------------
     1. Supported languages
     ----------------------------------------------------------- */
  var SUPPORTED_LANGUAGES = [
    { code: 'en', label: 'English',              native: 'English',    dir: 'ltr' },
    { code: 'fr', label: 'French',                native: 'Français',  dir: 'ltr' },
    { code: 'es', label: 'Spanish',                native: 'Español',   dir: 'ltr' },
    { code: 'ko', label: 'Korean',                 native: '한국어',     dir: 'ltr' },
    { code: 'de', label: 'German',                 native: 'Deutsch',   dir: 'ltr' },
    { code: 'pt', label: 'Portuguese',             native: 'Português', dir: 'ltr' },
    { code: 'ar', label: 'Arabic',                 native: 'العربية',   dir: 'rtl' },
    { code: 'zh', label: 'Chinese (Simplified)',   native: '简体中文',   dir: 'ltr' },
    { code: 'ja', label: 'Japanese',               native: '日本語',     dir: 'ltr' },
    { code: 'ha', label: 'Hausa',                  native: 'Hausa',     dir: 'ltr' }
  ];

  var DEFAULT_LANGUAGE = 'en';
  var STORAGE_KEY = 'meridian-lang';
  var STORAGE_KEY_SOURCE = 'meridian-lang-source'; // 'explicit' | 'geo' | 'browser'

  /* -----------------------------------------------------------
     2. Country -> language map, for the one-time geo default.
     Deliberately conservative: only includes a mapping where
     that language is genuinely the primary/official one for the
     country, so an automatic guess is never a surprising one.
     Countries not listed fall through to browser language, then
     English. Hausa is never auto-selected by geo — it's available
     for manual selection only, since it isn't a sole national
     language anywhere.
     ----------------------------------------------------------- */
  var COUNTRY_LANGUAGE_MAP = {
    FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr', CI: 'fr', SN: 'fr', CM: 'fr',
    ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', UY: 'es', EC: 'es', GT: 'es',
    KR: 'ko',
    DE: 'de', AT: 'de', CH: 'de',
    PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
    SA: 'ar', AE: 'ar', EG: 'ar', QA: 'ar', KW: 'ar', MA: 'ar', DZ: 'ar', TN: 'ar', JO: 'ar', IQ: 'ar',
    CN: 'zh',
    JP: 'ja',
    NG: 'en', GB: 'en', US: 'en', CA: 'en', AU: 'en', IE: 'en', NZ: 'en', ZA: 'en', GH: 'en', KE: 'en', SG: 'en', IN: 'en'
  };

  /* -----------------------------------------------------------
     3. Dictionaries
     ----------------------------------------------------------- */
  var TRANSLATIONS = {
    en: {
      'common.nav.overview': 'Overview',
      'common.nav.accounts': 'Accounts',
      'common.nav.transactions': 'Transactions',
      'common.nav.transfers': 'Transfers',
      'common.nav.cards': 'Cards',
      'common.nav.investments': 'Investments',
      'common.user_menu.profile': 'Profile',
      'common.user_menu.settings': 'Settings',
      'common.user_menu.statements': 'Statements',
      'common.user_menu.help': 'Help centre',
      'common.user_menu.logout': 'Log out',
      'common.search': 'Search',
      'common.notifications': 'Notifications',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.save': 'Save',
      'common.continue': 'Continue',
      'common.back': 'Back',
      'common.edit': 'Edit',
      'common.remove': 'Remove',
      'common.confirm': 'Confirm',
      'common.loading': 'Loading…',
      'common.search_placeholder': 'Search',
      'common.skip_to_content': 'Skip to main content',
      'common.menu': 'Open menu',
      'common.account_placeholder': 'Account',
      'common.try_again': 'Try again',
      'common.notifications.mark_all_read': 'Mark all read',
      'common.notifications.empty': "You're all caught up.",
      'common.notifications.error': "Couldn't load notifications.",
      'common.notifications.view_all': 'View all notifications',
      'dashboard.quick_action.send': 'Send',
      'dashboard.quick_action.add_money': 'Add money',
      'dashboard.quick_action.invest': 'Invest',
      'dashboard.quick_action.request': 'Request',
      'dashboard.balance.label': 'Total balance, converted to USD',
      'dashboard.balance.manage_accounts': 'Manage accounts',
      'dashboard.balance.hide': 'Hide balance',
      'dashboard.balance.show': 'Show balance',
      'dashboard.account_strip.add_currency': 'Add currency',
      'dashboard.tx.recent_title': 'Recent transactions',
      'dashboard.tx.view_all': 'View all',
      'dashboard.spending.title': 'Spending this month',
      'dashboard.spending.by_category': 'By category',
      'dashboard.goals.title': 'Savings goals',
      'dashboard.goals.new': 'New goal',
      'dashboard.cards.title': 'Your cards',
      'dashboard.cards.manage': 'Manage',
      'dashboard.upsell.title': 'Automate your money',
      'dashboard.upsell.body': "Set up a recurring transfer or a savings goal once — Meridian keeps it moving from there.",
      'dashboard.upsell.node.account': 'Account',
      'dashboard.upsell.node.autosave': 'Auto-save',
      'dashboard.upsell.node.goal': 'Goal',
      'dashboard.upsell.schedule_transfer': 'Schedule a transfer',
      'dashboard.upsell.start_goal': 'Start a savings goal',
      'dashboard.goal_modal.title': 'Start a savings goal',
      'dashboard.goal_modal.subtitle': 'Saved from your primary account.',
      'dashboard.goal_modal.name_label': "What are you saving for?",
      'dashboard.goal_modal.name_placeholder': 'e.g. Tokyo trip',
      'dashboard.goal_modal.amount_label': 'Target amount',
      'dashboard.goal_modal.date_label': 'Target date (optional)',
      'dashboard.goal_modal.submit': 'Create goal',
      'dashboard.ticker.aria_label': 'Live crypto market prices',
      'dashboard.ticker.loading': 'Loading market prices…',
      'dashboard.loading.overview': 'Loading your overview…',
      'chat.open_support': 'Open chat support',
      'chat.status.available': 'Live agent · available 24/7',
      'chat.options': 'Chat options',
      'chat.menu.sound.label': 'Play message sounds',
      'chat.menu.sound.hint': 'Chime when a reply arrives',
      'chat.menu.sound.on': 'On',
      'chat.menu.sound.off': 'Off',
      'chat.menu.transcript.label': 'Download transcript',
      'chat.menu.transcript.hint': 'Save this conversation as .txt',
      'chat.menu.accessibility.label': 'Accessibility',
      'chat.menu.accessibility.hint': 'Text size & contrast',
      'chat.menu.accessibility.larger_text': 'Larger text',
      'chat.menu.accessibility.high_contrast': 'High contrast',
      'chat.menu.accessibility.reduce_motion': 'Reduce motion',
      'chat.menu.privacy.label': 'Privacy & GDPR',
      'chat.menu.privacy.hint': 'Manage your chat data',
      'chat.menu.privacy.note_pre': 'This chat is encrypted in transit. Transcripts are kept for 90 days to improve support, then deleted, in line with our ',
      'chat.menu.privacy.note_link': 'privacy policy',
      'chat.menu.privacy.note_post': '.',
      'chat.menu.privacy.request_data': 'Request a copy of my data',
      'chat.menu.privacy.delete_data': 'Delete my chat data',
      'chat.menu.clear': 'Clear conversation',
      'chat.close': 'Close chat',
      'chat.loading': 'Connecting you to support…',
      'chat.remove_attachment': 'Remove attachment',
      'chat.attach': 'Attach a picture or document',
      'chat.input_label': 'Type a message',
      'chat.input_placeholder': 'Type your message...',
      'chat.send': 'Send message'
    },
    fr: {
      'common.nav.overview': "Vue d'ensemble",
      'common.nav.accounts': 'Comptes',
      'common.nav.transactions': 'Transactions',
      'common.nav.transfers': 'Virements',
      'common.nav.cards': 'Cartes',
      'common.nav.investments': 'Investissements',
      'common.user_menu.profile': 'Profil',
      'common.user_menu.settings': 'Paramètres',
      'common.user_menu.statements': 'Relevés',
      'common.user_menu.help': "Centre d'aide",
      'common.user_menu.logout': 'Déconnexion',
      'common.search': 'Rechercher',
      'common.notifications': 'Notifications',
      'common.close': 'Fermer',
      'common.cancel': 'Annuler',
      'common.save': 'Enregistrer',
      'common.continue': 'Continuer',
      'common.back': 'Retour',
      'common.edit': 'Modifier',
      'common.remove': 'Retirer',
      'common.confirm': 'Confirmer',
      'common.loading': 'Chargement…',
      'common.search_placeholder': 'Rechercher',
      'common.skip_to_content': 'Passer au contenu principal',
      'common.menu': 'Ouvrir le menu',
      'common.account_placeholder': 'Compte',
      'common.try_again': 'Réessayer',
      'common.notifications.mark_all_read': 'Tout marquer comme lu',
      'common.notifications.empty': 'Vous êtes à jour.',
      'common.notifications.error': 'Impossible de charger les notifications.',
      'common.notifications.view_all': 'Voir toutes les notifications',
      'dashboard.quick_action.send': 'Envoyer',
      'dashboard.quick_action.add_money': 'Ajouter des fonds',
      'dashboard.quick_action.invest': 'Investir',
      'dashboard.quick_action.request': 'Demander',
      'dashboard.balance.label': 'Solde total, converti en USD',
      'dashboard.balance.manage_accounts': 'Gérer les comptes',
      'dashboard.balance.hide': 'Masquer le solde',
      'dashboard.balance.show': 'Afficher le solde',
      'dashboard.account_strip.add_currency': 'Ajouter une devise',
      'dashboard.tx.recent_title': 'Transactions récentes',
      'dashboard.tx.view_all': 'Tout afficher',
      'dashboard.spending.title': 'Dépenses ce mois-ci',
      'dashboard.spending.by_category': 'Par catégorie',
      'dashboard.goals.title': "Objectifs d'épargne",
      'dashboard.goals.new': 'Nouvel objectif',
      'dashboard.cards.title': 'Vos cartes',
      'dashboard.cards.manage': 'Gérer',
      'dashboard.upsell.title': 'Automatisez votre argent',
      'dashboard.upsell.body': "Configurez un virement récurrent ou un objectif d'épargne une seule fois — Meridian s'occupe du reste.",
      'dashboard.upsell.node.account': 'Compte',
      'dashboard.upsell.node.autosave': 'Épargne auto',
      'dashboard.upsell.node.goal': 'Objectif',
      'dashboard.upsell.schedule_transfer': 'Programmer un virement',
      'dashboard.upsell.start_goal': "Démarrer un objectif d'épargne",
      'dashboard.goal_modal.title': "Démarrer un objectif d'épargne",
      'dashboard.goal_modal.subtitle': 'Épargné depuis votre compte principal.',
      'dashboard.goal_modal.name_label': 'Pour quoi épargnez-vous ?',
      'dashboard.goal_modal.name_placeholder': 'ex. Voyage à Tokyo',
      'dashboard.goal_modal.amount_label': 'Montant cible',
      'dashboard.goal_modal.date_label': 'Date cible (facultatif)',
      'dashboard.goal_modal.submit': "Créer l'objectif",
      'dashboard.ticker.aria_label': 'Prix du marché crypto en direct',
      'dashboard.ticker.loading': 'Chargement des prix du marché…',
      'dashboard.loading.overview': 'Chargement de votre aperçu…',
      'chat.open_support': "Ouvrir le chat d'assistance",
      'chat.status.available': 'Agent en direct · disponible 24 h/24, 7 j/7',
      'chat.options': 'Options du chat',
      'chat.menu.sound.label': 'Activer les sons des messages',
      'chat.menu.sound.hint': 'Un signal sonore à chaque réponse',
      'chat.menu.sound.on': 'Activé',
      'chat.menu.sound.off': 'Désactivé',
      'chat.menu.transcript.label': 'Télécharger la transcription',
      'chat.menu.transcript.hint': 'Enregistrer cette conversation en .txt',
      'chat.menu.accessibility.label': 'Accessibilité',
      'chat.menu.accessibility.hint': 'Taille du texte et contraste',
      'chat.menu.accessibility.larger_text': 'Texte plus grand',
      'chat.menu.accessibility.high_contrast': 'Contraste élevé',
      'chat.menu.accessibility.reduce_motion': 'Réduire les animations',
      'chat.menu.privacy.label': 'Confidentialité et RGPD',
      'chat.menu.privacy.hint': 'Gérer vos données de chat',
      'chat.menu.privacy.note_pre': 'Ce chat est chiffré en transit. Les transcriptions sont conservées 90 jours pour améliorer le support, puis supprimées, conformément à notre ',
      'chat.menu.privacy.note_link': 'politique de confidentialité',
      'chat.menu.privacy.note_post': '.',
      'chat.menu.privacy.request_data': 'Demander une copie de mes données',
      'chat.menu.privacy.delete_data': 'Supprimer mes données de chat',
      'chat.menu.clear': 'Effacer la conversation',
      'chat.close': 'Fermer le chat',
      'chat.loading': 'Connexion au support…',
      'chat.remove_attachment': 'Supprimer la pièce jointe',
      'chat.attach': 'Joindre une image ou un document',
      'chat.input_label': 'Écrire un message',
      'chat.input_placeholder': 'Écrivez votre message...',
      'chat.send': 'Envoyer le message'
    },
    es: {
      'common.nav.overview': 'Resumen',
      'common.nav.accounts': 'Cuentas',
      'common.nav.transactions': 'Transacciones',
      'common.nav.transfers': 'Transferencias',
      'common.nav.cards': 'Tarjetas',
      'common.nav.investments': 'Inversiones',
      'common.user_menu.profile': 'Perfil',
      'common.user_menu.settings': 'Configuración',
      'common.user_menu.statements': 'Estados de cuenta',
      'common.user_menu.help': 'Centro de ayuda',
      'common.user_menu.logout': 'Cerrar sesión',
      'common.search': 'Buscar',
      'common.notifications': 'Notificaciones',
      'common.close': 'Cerrar',
      'common.cancel': 'Cancelar',
      'common.save': 'Guardar',
      'common.continue': 'Continuar',
      'common.back': 'Atrás',
      'common.edit': 'Editar',
      'common.remove': 'Quitar',
      'common.confirm': 'Confirmar',
      'common.loading': 'Cargando…',
      'common.search_placeholder': 'Buscar',
      'common.skip_to_content': 'Saltar al contenido principal',
      'common.menu': 'Abrir menú',
      'common.account_placeholder': 'Cuenta',
      'common.try_again': 'Reintentar',
      'common.notifications.mark_all_read': 'Marcar todo como leído',
      'common.notifications.empty': 'Estás al día.',
      'common.notifications.error': 'No se pudieron cargar las notificaciones.',
      'common.notifications.view_all': 'Ver todas las notificaciones',
      'dashboard.quick_action.send': 'Enviar',
      'dashboard.quick_action.add_money': 'Añadir dinero',
      'dashboard.quick_action.invest': 'Invertir',
      'dashboard.quick_action.request': 'Solicitar',
      'dashboard.balance.label': 'Saldo total, convertido a USD',
      'dashboard.balance.manage_accounts': 'Gestionar cuentas',
      'dashboard.balance.hide': 'Ocultar saldo',
      'dashboard.balance.show': 'Mostrar saldo',
      'dashboard.account_strip.add_currency': 'Añadir divisa',
      'dashboard.tx.recent_title': 'Transacciones recientes',
      'dashboard.tx.view_all': 'Ver todo',
      'dashboard.spending.title': 'Gastos de este mes',
      'dashboard.spending.by_category': 'Por categoría',
      'dashboard.goals.title': 'Metas de ahorro',
      'dashboard.goals.new': 'Nueva meta',
      'dashboard.cards.title': 'Tus tarjetas',
      'dashboard.cards.manage': 'Gestionar',
      'dashboard.upsell.title': 'Automatiza tu dinero',
      'dashboard.upsell.body': 'Configura una transferencia recurrente o una meta de ahorro una sola vez — Meridian se encarga del resto.',
      'dashboard.upsell.node.account': 'Cuenta',
      'dashboard.upsell.node.autosave': 'Ahorro automático',
      'dashboard.upsell.node.goal': 'Meta',
      'dashboard.upsell.schedule_transfer': 'Programar transferencia',
      'dashboard.upsell.start_goal': 'Iniciar meta de ahorro',
      'dashboard.goal_modal.title': 'Iniciar una meta de ahorro',
      'dashboard.goal_modal.subtitle': 'Ahorrado desde tu cuenta principal.',
      'dashboard.goal_modal.name_label': '¿Para qué estás ahorrando?',
      'dashboard.goal_modal.name_placeholder': 'p. ej. Viaje a Tokio',
      'dashboard.goal_modal.amount_label': 'Monto objetivo',
      'dashboard.goal_modal.date_label': 'Fecha objetivo (opcional)',
      'dashboard.goal_modal.submit': 'Crear meta',
      'dashboard.ticker.aria_label': 'Precios del mercado cripto en vivo',
      'dashboard.ticker.loading': 'Cargando precios del mercado…',
      'dashboard.loading.overview': 'Cargando tu resumen…',
      'chat.open_support': 'Abrir chat de soporte',
      'chat.status.available': 'Agente en vivo · disponible 24/7',
      'chat.options': 'Opciones del chat',
      'chat.menu.sound.label': 'Reproducir sonidos de mensajes',
      'chat.menu.sound.hint': 'Sonido al recibir una respuesta',
      'chat.menu.sound.on': 'Activado',
      'chat.menu.sound.off': 'Desactivado',
      'chat.menu.transcript.label': 'Descargar transcripción',
      'chat.menu.transcript.hint': 'Guardar esta conversación como .txt',
      'chat.menu.accessibility.label': 'Accesibilidad',
      'chat.menu.accessibility.hint': 'Tamaño de texto y contraste',
      'chat.menu.accessibility.larger_text': 'Texto más grande',
      'chat.menu.accessibility.high_contrast': 'Alto contraste',
      'chat.menu.accessibility.reduce_motion': 'Reducir animaciones',
      'chat.menu.privacy.label': 'Privacidad y RGPD',
      'chat.menu.privacy.hint': 'Gestiona tus datos de chat',
      'chat.menu.privacy.note_pre': 'Este chat está cifrado en tránsito. Las transcripciones se conservan durante 90 días para mejorar el soporte y luego se eliminan, conforme a nuestra ',
      'chat.menu.privacy.note_link': 'política de privacidad',
      'chat.menu.privacy.note_post': '.',
      'chat.menu.privacy.request_data': 'Solicitar una copia de mis datos',
      'chat.menu.privacy.delete_data': 'Eliminar mis datos de chat',
      'chat.menu.clear': 'Borrar conversación',
      'chat.close': 'Cerrar chat',
      'chat.loading': 'Conectando con soporte…',
      'chat.remove_attachment': 'Quitar archivo adjunto',
      'chat.attach': 'Adjuntar una imagen o documento',
      'chat.input_label': 'Escribir un mensaje',
      'chat.input_placeholder': 'Escribe tu mensaje...',
      'chat.send': 'Enviar mensaje'
    },
    ko: {
      'common.nav.overview': '개요',
      'common.nav.accounts': '계좌',
      'common.nav.transactions': '거래 내역',
      'common.nav.transfers': '송금',
      'common.nav.cards': '카드',
      'common.nav.investments': '투자',
      'common.user_menu.profile': '프로필',
      'common.user_menu.settings': '설정',
      'common.user_menu.statements': '명세서',
      'common.user_menu.help': '고객센터',
      'common.user_menu.logout': '로그아웃',
      'common.search': '검색',
      'common.notifications': '알림',
      'common.close': '닫기',
      'common.cancel': '취소',
      'common.save': '저장',
      'common.continue': '계속',
      'common.back': '뒤로',
      'common.edit': '수정',
      'common.remove': '삭제',
      'common.confirm': '확인',
      'common.loading': '로딩 중…',
      'common.search_placeholder': '검색',
      'common.skip_to_content': '본문으로 건너뛰기',
      'common.menu': '메뉴 열기',
      'common.account_placeholder': '계정',
      'common.try_again': '다시 시도',
      'common.notifications.mark_all_read': '모두 읽음으로 표시',
      'common.notifications.empty': '모든 알림을 확인했습니다.',
      'common.notifications.error': '알림을 불러올 수 없습니다.',
      'common.notifications.view_all': '모든 알림 보기',
      'dashboard.quick_action.send': '보내기',
      'dashboard.quick_action.add_money': '충전하기',
      'dashboard.quick_action.invest': '투자하기',
      'dashboard.quick_action.request': '요청하기',
      'dashboard.balance.label': '총 잔액 (USD 환산)',
      'dashboard.balance.manage_accounts': '계좌 관리',
      'dashboard.balance.hide': '잔액 숨기기',
      'dashboard.balance.show': '잔액 표시',
      'dashboard.account_strip.add_currency': '통화 추가',
      'dashboard.tx.recent_title': '최근 거래',
      'dashboard.tx.view_all': '전체 보기',
      'dashboard.spending.title': '이번 달 지출',
      'dashboard.spending.by_category': '카테고리별',
      'dashboard.goals.title': '저축 목표',
      'dashboard.goals.new': '새 목표',
      'dashboard.cards.title': '내 카드',
      'dashboard.cards.manage': '관리',
      'dashboard.upsell.title': '자산을 자동으로 관리하세요',
      'dashboard.upsell.body': '정기 송금이나 저축 목표를 한 번만 설정하면 Meridian이 알아서 진행합니다.',
      'dashboard.upsell.node.account': '계좌',
      'dashboard.upsell.node.autosave': '자동 저축',
      'dashboard.upsell.node.goal': '목표',
      'dashboard.upsell.schedule_transfer': '송금 예약',
      'dashboard.upsell.start_goal': '저축 목표 시작',
      'dashboard.goal_modal.title': '저축 목표 시작하기',
      'dashboard.goal_modal.subtitle': '주 계좌에서 저축됩니다.',
      'dashboard.goal_modal.name_label': '무엇을 위해 저축하시나요?',
      'dashboard.goal_modal.name_placeholder': '예: 도쿄 여행',
      'dashboard.goal_modal.amount_label': '목표 금액',
      'dashboard.goal_modal.date_label': '목표 날짜 (선택)',
      'dashboard.goal_modal.submit': '목표 만들기',
      'dashboard.ticker.aria_label': '실시간 암호화폐 시세',
      'dashboard.ticker.loading': '시세 불러오는 중…',
      'dashboard.loading.overview': '개요를 불러오는 중…',
      'chat.open_support': '상담 채팅 열기',
      'chat.status.available': '실시간 상담원 · 24시간 연중무휴',
      'chat.options': '채팅 옵션',
      'chat.menu.sound.label': '메시지 알림음 재생',
      'chat.menu.sound.hint': '답장이 오면 알림음 재생',
      'chat.menu.sound.on': '켜짐',
      'chat.menu.sound.off': '꺼짐',
      'chat.menu.transcript.label': '대화 내용 다운로드',
      'chat.menu.transcript.hint': '이 대화를 .txt로 저장',
      'chat.menu.accessibility.label': '접근성',
      'chat.menu.accessibility.hint': '글자 크기 및 명암',
      'chat.menu.accessibility.larger_text': '큰 텍스트',
      'chat.menu.accessibility.high_contrast': '고대비',
      'chat.menu.accessibility.reduce_motion': '애니메이션 줄이기',
      'chat.menu.privacy.label': '개인정보 및 GDPR',
      'chat.menu.privacy.hint': '채팅 데이터 관리',
      'chat.menu.privacy.note_pre': '이 채팅은 전송 중 암호화됩니다. 상담 품질 향상을 위해 대화 내용은 90일간 보관된 후 삭제되며, 자세한 내용은 당사 ',
      'chat.menu.privacy.note_link': '개인정보 처리방침',
      'chat.menu.privacy.note_post': '을 참고하세요.',
      'chat.menu.privacy.request_data': '내 데이터 사본 요청',
      'chat.menu.privacy.delete_data': '내 채팅 데이터 삭제',
      'chat.menu.clear': '대화 지우기',
      'chat.close': '채팅 닫기',
      'chat.loading': '상담원에게 연결하는 중…',
      'chat.remove_attachment': '첨부 파일 제거',
      'chat.attach': '이미지 또는 문서 첨부',
      'chat.input_label': '메시지 입력',
      'chat.input_placeholder': '메시지를 입력하세요...',
      'chat.send': '메시지 보내기'
    },
    de: {
      'common.nav.overview': 'Übersicht',
      'common.nav.accounts': 'Konten',
      'common.nav.transactions': 'Transaktionen',
      'common.nav.transfers': 'Überweisungen',
      'common.nav.cards': 'Karten',
      'common.nav.investments': 'Investitionen',
      'common.user_menu.profile': 'Profil',
      'common.user_menu.settings': 'Einstellungen',
      'common.user_menu.statements': 'Kontoauszüge',
      'common.user_menu.help': 'Hilfecenter',
      'common.user_menu.logout': 'Abmelden',
      'common.search': 'Suchen',
      'common.notifications': 'Benachrichtigungen',
      'common.close': 'Schließen',
      'common.cancel': 'Abbrechen',
      'common.save': 'Speichern',
      'common.continue': 'Weiter',
      'common.back': 'Zurück',
      'common.edit': 'Bearbeiten',
      'common.remove': 'Entfernen',
      'common.confirm': 'Bestätigen',
      'common.loading': 'Wird geladen…',
      'common.search_placeholder': 'Suchen',
      'common.skip_to_content': 'Zum Hauptinhalt springen',
      'common.menu': 'Menü öffnen',
      'common.account_placeholder': 'Konto',
      'common.try_again': 'Erneut versuchen',
      'common.notifications.mark_all_read': 'Alle als gelesen markieren',
      'common.notifications.empty': 'Du bist auf dem neuesten Stand.',
      'common.notifications.error': 'Benachrichtigungen konnten nicht geladen werden.',
      'common.notifications.view_all': 'Alle Benachrichtigungen anzeigen',
      'dashboard.quick_action.send': 'Senden',
      'dashboard.quick_action.add_money': 'Geld hinzufügen',
      'dashboard.quick_action.invest': 'Investieren',
      'dashboard.quick_action.request': 'Anfordern',
      'dashboard.balance.label': 'Gesamtguthaben, umgerechnet in USD',
      'dashboard.balance.manage_accounts': 'Konten verwalten',
      'dashboard.balance.hide': 'Guthaben ausblenden',
      'dashboard.balance.show': 'Guthaben anzeigen',
      'dashboard.account_strip.add_currency': 'Währung hinzufügen',
      'dashboard.tx.recent_title': 'Letzte Transaktionen',
      'dashboard.tx.view_all': 'Alle anzeigen',
      'dashboard.spending.title': 'Ausgaben diesen Monat',
      'dashboard.spending.by_category': 'Nach Kategorie',
      'dashboard.goals.title': 'Sparziele',
      'dashboard.goals.new': 'Neues Ziel',
      'dashboard.cards.title': 'Deine Karten',
      'dashboard.cards.manage': 'Verwalten',
      'dashboard.upsell.title': 'Automatisiere dein Geld',
      'dashboard.upsell.body': 'Richte einmal eine wiederkehrende Überweisung oder ein Sparziel ein — Meridian übernimmt den Rest.',
      'dashboard.upsell.node.account': 'Konto',
      'dashboard.upsell.node.autosave': 'Auto-Sparen',
      'dashboard.upsell.node.goal': 'Ziel',
      'dashboard.upsell.schedule_transfer': 'Überweisung planen',
      'dashboard.upsell.start_goal': 'Sparziel starten',
      'dashboard.goal_modal.title': 'Sparziel starten',
      'dashboard.goal_modal.subtitle': 'Gespart von deinem Hauptkonto.',
      'dashboard.goal_modal.name_label': 'Wofür sparst du?',
      'dashboard.goal_modal.name_placeholder': 'z. B. Tokio-Reise',
      'dashboard.goal_modal.amount_label': 'Zielbetrag',
      'dashboard.goal_modal.date_label': 'Zieldatum (optional)',
      'dashboard.goal_modal.submit': 'Ziel erstellen',
      'dashboard.ticker.aria_label': 'Live-Kryptomarktpreise',
      'dashboard.ticker.loading': 'Marktpreise werden geladen…',
      'dashboard.loading.overview': 'Übersicht wird geladen…',
      'chat.open_support': 'Support-Chat öffnen',
      'chat.status.available': 'Live-Mitarbeiter · rund um die Uhr verfügbar',
      'chat.options': 'Chat-Optionen',
      'chat.menu.sound.label': 'Nachrichtentöne abspielen',
      'chat.menu.sound.hint': 'Ton bei eingehender Antwort',
      'chat.menu.sound.on': 'An',
      'chat.menu.sound.off': 'Aus',
      'chat.menu.transcript.label': 'Transkript herunterladen',
      'chat.menu.transcript.hint': 'Diese Unterhaltung als .txt speichern',
      'chat.menu.accessibility.label': 'Barrierefreiheit',
      'chat.menu.accessibility.hint': 'Textgröße & Kontrast',
      'chat.menu.accessibility.larger_text': 'Größerer Text',
      'chat.menu.accessibility.high_contrast': 'Hoher Kontrast',
      'chat.menu.accessibility.reduce_motion': 'Animationen reduzieren',
      'chat.menu.privacy.label': 'Datenschutz & DSGVO',
      'chat.menu.privacy.hint': 'Deine Chatdaten verwalten',
      'chat.menu.privacy.note_pre': 'Dieser Chat ist bei der Übertragung verschlüsselt. Transkripte werden 90 Tage lang aufbewahrt, um den Support zu verbessern, und dann gemäß unserer ',
      'chat.menu.privacy.note_link': 'Datenschutzrichtlinie',
      'chat.menu.privacy.note_post': ' gelöscht.',
      'chat.menu.privacy.request_data': 'Eine Kopie meiner Daten anfordern',
      'chat.menu.privacy.delete_data': 'Meine Chatdaten löschen',
      'chat.menu.clear': 'Unterhaltung löschen',
      'chat.close': 'Chat schließen',
      'chat.loading': 'Verbindung zum Support wird hergestellt…',
      'chat.remove_attachment': 'Anhang entfernen',
      'chat.attach': 'Bild oder Dokument anhängen',
      'chat.input_label': 'Nachricht eingeben',
      'chat.input_placeholder': 'Schreibe deine Nachricht...',
      'chat.send': 'Nachricht senden'
    },
    pt: {
      'common.nav.overview': 'Visão geral',
      'common.nav.accounts': 'Contas',
      'common.nav.transactions': 'Transações',
      'common.nav.transfers': 'Transferências',
      'common.nav.cards': 'Cartões',
      'common.nav.investments': 'Investimentos',
      'common.user_menu.profile': 'Perfil',
      'common.user_menu.settings': 'Configurações',
      'common.user_menu.statements': 'Extratos',
      'common.user_menu.help': 'Central de ajuda',
      'common.user_menu.logout': 'Sair',
      'common.search': 'Pesquisar',
      'common.notifications': 'Notificações',
      'common.close': 'Fechar',
      'common.cancel': 'Cancelar',
      'common.save': 'Salvar',
      'common.continue': 'Continuar',
      'common.back': 'Voltar',
      'common.edit': 'Editar',
      'common.remove': 'Remover',
      'common.confirm': 'Confirmar',
      'common.loading': 'Carregando…',
      'common.search_placeholder': 'Pesquisar',
      'common.skip_to_content': 'Pular para o conteúdo principal',
      'common.menu': 'Abrir menu',
      'common.account_placeholder': 'Conta',
      'common.try_again': 'Tentar novamente',
      'common.notifications.mark_all_read': 'Marcar tudo como lido',
      'common.notifications.empty': 'Você está em dia.',
      'common.notifications.error': 'Não foi possível carregar as notificações.',
      'common.notifications.view_all': 'Ver todas as notificações',
      'dashboard.quick_action.send': 'Enviar',
      'dashboard.quick_action.add_money': 'Adicionar dinheiro',
      'dashboard.quick_action.invest': 'Investir',
      'dashboard.quick_action.request': 'Solicitar',
      'dashboard.balance.label': 'Saldo total, convertido para USD',
      'dashboard.balance.manage_accounts': 'Gerenciar contas',
      'dashboard.balance.hide': 'Ocultar saldo',
      'dashboard.balance.show': 'Mostrar saldo',
      'dashboard.account_strip.add_currency': 'Adicionar moeda',
      'dashboard.tx.recent_title': 'Transações recentes',
      'dashboard.tx.view_all': 'Ver tudo',
      'dashboard.spending.title': 'Gastos deste mês',
      'dashboard.spending.by_category': 'Por categoria',
      'dashboard.goals.title': 'Metas de poupança',
      'dashboard.goals.new': 'Nova meta',
      'dashboard.cards.title': 'Seus cartões',
      'dashboard.cards.manage': 'Gerenciar',
      'dashboard.upsell.title': 'Automatize seu dinheiro',
      'dashboard.upsell.body': 'Configure uma transferência recorrente ou uma meta de poupança uma vez — o Meridian cuida do resto.',
      'dashboard.upsell.node.account': 'Conta',
      'dashboard.upsell.node.autosave': 'Poupança automática',
      'dashboard.upsell.node.goal': 'Meta',
      'dashboard.upsell.schedule_transfer': 'Agendar transferência',
      'dashboard.upsell.start_goal': 'Iniciar meta de poupança',
      'dashboard.goal_modal.title': 'Iniciar uma meta de poupança',
      'dashboard.goal_modal.subtitle': 'Poupado a partir da sua conta principal.',
      'dashboard.goal_modal.name_label': 'Para que você está poupando?',
      'dashboard.goal_modal.name_placeholder': 'ex. Viagem a Tóquio',
      'dashboard.goal_modal.amount_label': 'Valor da meta',
      'dashboard.goal_modal.date_label': 'Data da meta (opcional)',
      'dashboard.goal_modal.submit': 'Criar meta',
      'dashboard.ticker.aria_label': 'Preços de criptomoedas ao vivo',
      'dashboard.ticker.loading': 'Carregando preços do mercado…',
      'dashboard.loading.overview': 'Carregando sua visão geral…',
      'chat.open_support': 'Abrir chat de suporte',
      'chat.status.available': 'Agente ao vivo · disponível 24 horas',
      'chat.options': 'Opções do chat',
      'chat.menu.sound.label': 'Reproduzir sons de mensagens',
      'chat.menu.sound.hint': 'Toque quando chegar uma resposta',
      'chat.menu.sound.on': 'Ativado',
      'chat.menu.sound.off': 'Desativado',
      'chat.menu.transcript.label': 'Baixar transcrição',
      'chat.menu.transcript.hint': 'Salvar esta conversa como .txt',
      'chat.menu.accessibility.label': 'Acessibilidade',
      'chat.menu.accessibility.hint': 'Tamanho do texto e contraste',
      'chat.menu.accessibility.larger_text': 'Texto maior',
      'chat.menu.accessibility.high_contrast': 'Alto contraste',
      'chat.menu.accessibility.reduce_motion': 'Reduzir animações',
      'chat.menu.privacy.label': 'Privacidade e LGPD',
      'chat.menu.privacy.hint': 'Gerencie seus dados de chat',
      'chat.menu.privacy.note_pre': 'Este chat é criptografado em trânsito. As transcrições são mantidas por 90 dias para melhorar o suporte e depois excluídas, conforme nossa ',
      'chat.menu.privacy.note_link': 'política de privacidade',
      'chat.menu.privacy.note_post': '.',
      'chat.menu.privacy.request_data': 'Solicitar uma cópia dos meus dados',
      'chat.menu.privacy.delete_data': 'Excluir meus dados de chat',
      'chat.menu.clear': 'Limpar conversa',
      'chat.close': 'Fechar chat',
      'chat.loading': 'Conectando você ao suporte…',
      'chat.remove_attachment': 'Remover anexo',
      'chat.attach': 'Anexar uma imagem ou documento',
      'chat.input_label': 'Digitar uma mensagem',
      'chat.input_placeholder': 'Digite sua mensagem...',
      'chat.send': 'Enviar mensagem'
    },
    ar: {
      'common.nav.overview': 'نظرة عامة',
      'common.nav.accounts': 'الحسابات',
      'common.nav.transactions': 'المعاملات',
      'common.nav.transfers': 'التحويلات',
      'common.nav.cards': 'البطاقات',
      'common.nav.investments': 'الاستثمارات',
      'common.user_menu.profile': 'الملف الشخصي',
      'common.user_menu.settings': 'الإعدادات',
      'common.user_menu.statements': 'كشوف الحساب',
      'common.user_menu.help': 'مركز المساعدة',
      'common.user_menu.logout': 'تسجيل الخروج',
      'common.search': 'بحث',
      'common.notifications': 'الإشعارات',
      'common.close': 'إغلاق',
      'common.cancel': 'إلغاء',
      'common.save': 'حفظ',
      'common.continue': 'متابعة',
      'common.back': 'رجوع',
      'common.edit': 'تعديل',
      'common.remove': 'إزالة',
      'common.confirm': 'تأكيد',
      'common.loading': 'جارٍ التحميل…',
      'common.search_placeholder': 'بحث',
      'common.skip_to_content': 'الانتقال إلى المحتوى الرئيسي',
      'common.menu': 'فتح القائمة',
      'common.account_placeholder': 'الحساب',
      'common.try_again': 'إعادة المحاولة',
      'common.notifications.mark_all_read': 'وضع علامة مقروء على الكل',
      'common.notifications.empty': 'أنت على اطلاع بكل شيء.',
      'common.notifications.error': 'تعذّر تحميل الإشعارات.',
      'common.notifications.view_all': 'عرض جميع الإشعارات',
      'dashboard.quick_action.send': 'إرسال',
      'dashboard.quick_action.add_money': 'إضافة أموال',
      'dashboard.quick_action.invest': 'استثمار',
      'dashboard.quick_action.request': 'طلب',
      'dashboard.balance.label': 'الرصيد الإجمالي، محوّل إلى دولار أمريكي',
      'dashboard.balance.manage_accounts': 'إدارة الحسابات',
      'dashboard.balance.hide': 'إخفاء الرصيد',
      'dashboard.balance.show': 'إظهار الرصيد',
      'dashboard.account_strip.add_currency': 'إضافة عملة',
      'dashboard.tx.recent_title': 'المعاملات الأخيرة',
      'dashboard.tx.view_all': 'عرض الكل',
      'dashboard.spending.title': 'الإنفاق هذا الشهر',
      'dashboard.spending.by_category': 'حسب الفئة',
      'dashboard.goals.title': 'أهداف الادخار',
      'dashboard.goals.new': 'هدف جديد',
      'dashboard.cards.title': 'بطاقاتك',
      'dashboard.cards.manage': 'إدارة',
      'dashboard.upsell.title': 'أتمتة أموالك',
      'dashboard.upsell.body': 'أنشئ تحويلاً متكررًا أو هدف ادخار مرة واحدة — وسيتولى Meridian الباقي.',
      'dashboard.upsell.node.account': 'الحساب',
      'dashboard.upsell.node.autosave': 'ادخار تلقائي',
      'dashboard.upsell.node.goal': 'الهدف',
      'dashboard.upsell.schedule_transfer': 'جدولة تحويل',
      'dashboard.upsell.start_goal': 'بدء هدف ادخار',
      'dashboard.goal_modal.title': 'بدء هدف ادخار',
      'dashboard.goal_modal.subtitle': 'يُدّخر من حسابك الرئيسي.',
      'dashboard.goal_modal.name_label': 'لماذا تدّخر؟',
      'dashboard.goal_modal.name_placeholder': 'مثال: رحلة إلى طوكيو',
      'dashboard.goal_modal.amount_label': 'المبلغ المستهدف',
      'dashboard.goal_modal.date_label': 'التاريخ المستهدف (اختياري)',
      'dashboard.goal_modal.submit': 'إنشاء الهدف',
      'dashboard.ticker.aria_label': 'أسعار العملات الرقمية المباشرة',
      'dashboard.ticker.loading': 'جارٍ تحميل أسعار السوق…',
      'dashboard.loading.overview': 'جارٍ تحميل نظرتك العامة…',
      'chat.open_support': 'فتح محادثة الدعم',
      'chat.status.available': 'وكيل مباشر · متاح على مدار الساعة',
      'chat.options': 'خيارات المحادثة',
      'chat.menu.sound.label': 'تشغيل أصوات الرسائل',
      'chat.menu.sound.hint': 'رنين عند وصول رد',
      'chat.menu.sound.on': 'مفعّل',
      'chat.menu.sound.off': 'متوقف',
      'chat.menu.transcript.label': 'تنزيل نص المحادثة',
      'chat.menu.transcript.hint': 'حفظ هذه المحادثة بصيغة .txt',
      'chat.menu.accessibility.label': 'إمكانية الوصول',
      'chat.menu.accessibility.hint': 'حجم النص والتباين',
      'chat.menu.accessibility.larger_text': 'نص أكبر',
      'chat.menu.accessibility.high_contrast': 'تباين عالٍ',
      'chat.menu.accessibility.reduce_motion': 'تقليل الحركة',
      'chat.menu.privacy.label': 'الخصوصية واللائحة العامة لحماية البيانات',
      'chat.menu.privacy.hint': 'إدارة بيانات المحادثة الخاصة بك',
      'chat.menu.privacy.note_pre': 'هذه المحادثة مشفّرة أثناء النقل. يتم الاحتفاظ بنصوص المحادثات لمدة 90 يومًا لتحسين الدعم، ثم تُحذف، وفقًا لـ ',
      'chat.menu.privacy.note_link': 'سياسة الخصوصية',
      'chat.menu.privacy.note_post': ' الخاصة بنا.',
      'chat.menu.privacy.request_data': 'طلب نسخة من بياناتي',
      'chat.menu.privacy.delete_data': 'حذف بيانات المحادثة الخاصة بي',
      'chat.menu.clear': 'مسح المحادثة',
      'chat.close': 'إغلاق المحادثة',
      'chat.loading': 'جارٍ توصيلك بالدعم…',
      'chat.remove_attachment': 'إزالة المرفق',
      'chat.attach': 'إرفاق صورة أو مستند',
      'chat.input_label': 'كتابة رسالة',
      'chat.input_placeholder': 'اكتب رسالتك...',
      'chat.send': 'إرسال الرسالة'
    },
    zh: {
      'common.nav.overview': '概览',
      'common.nav.accounts': '账户',
      'common.nav.transactions': '交易记录',
      'common.nav.transfers': '转账',
      'common.nav.cards': '卡片',
      'common.nav.investments': '投资',
      'common.user_menu.profile': '个人资料',
      'common.user_menu.settings': '设置',
      'common.user_menu.statements': '账单',
      'common.user_menu.help': '帮助中心',
      'common.user_menu.logout': '退出登录',
      'common.search': '搜索',
      'common.notifications': '通知',
      'common.close': '关闭',
      'common.cancel': '取消',
      'common.save': '保存',
      'common.continue': '继续',
      'common.back': '返回',
      'common.edit': '编辑',
      'common.remove': '移除',
      'common.confirm': '确认',
      'common.loading': '加载中…',
      'common.search_placeholder': '搜索',
      'common.skip_to_content': '跳转到主要内容',
      'common.menu': '打开菜单',
      'common.account_placeholder': '账户',
      'common.try_again': '重试',
      'common.notifications.mark_all_read': '全部标记为已读',
      'common.notifications.empty': '暂无新通知。',
      'common.notifications.error': '无法加载通知。',
      'common.notifications.view_all': '查看全部通知',
      'dashboard.quick_action.send': '转出',
      'dashboard.quick_action.add_money': '充值',
      'dashboard.quick_action.invest': '投资',
      'dashboard.quick_action.request': '请求付款',
      'dashboard.balance.label': '总余额（折合美元）',
      'dashboard.balance.manage_accounts': '管理账户',
      'dashboard.balance.hide': '隐藏余额',
      'dashboard.balance.show': '显示余额',
      'dashboard.account_strip.add_currency': '添加币种',
      'dashboard.tx.recent_title': '最近交易',
      'dashboard.tx.view_all': '查看全部',
      'dashboard.spending.title': '本月支出',
      'dashboard.spending.by_category': '按类别',
      'dashboard.goals.title': '储蓄目标',
      'dashboard.goals.new': '新建目标',
      'dashboard.cards.title': '我的卡片',
      'dashboard.cards.manage': '管理',
      'dashboard.upsell.title': '自动管理资金',
      'dashboard.upsell.body': '只需设置一次定期转账或储蓄目标，Meridian 会持续为您执行。',
      'dashboard.upsell.node.account': '账户',
      'dashboard.upsell.node.autosave': '自动储蓄',
      'dashboard.upsell.node.goal': '目标',
      'dashboard.upsell.schedule_transfer': '安排转账',
      'dashboard.upsell.start_goal': '开始储蓄目标',
      'dashboard.goal_modal.title': '开始储蓄目标',
      'dashboard.goal_modal.subtitle': '从您的主账户储蓄。',
      'dashboard.goal_modal.name_label': '您在为什么储蓄？',
      'dashboard.goal_modal.name_placeholder': '例如：东京之旅',
      'dashboard.goal_modal.amount_label': '目标金额',
      'dashboard.goal_modal.date_label': '目标日期（可选）',
      'dashboard.goal_modal.submit': '创建目标',
      'dashboard.ticker.aria_label': '实时加密货币行情',
      'dashboard.ticker.loading': '正在加载行情…',
      'dashboard.loading.overview': '正在加载您的概览…',
      'chat.open_support': '打开客服聊天',
      'chat.status.available': '人工客服 · 全天候在线',
      'chat.options': '聊天选项',
      'chat.menu.sound.label': '播放消息提示音',
      'chat.menu.sound.hint': '收到回复时提示音',
      'chat.menu.sound.on': '开',
      'chat.menu.sound.off': '关',
      'chat.menu.transcript.label': '下载聊天记录',
      'chat.menu.transcript.hint': '将此对话保存为 .txt 文件',
      'chat.menu.accessibility.label': '辅助功能',
      'chat.menu.accessibility.hint': '文字大小与对比度',
      'chat.menu.accessibility.larger_text': '放大文字',
      'chat.menu.accessibility.high_contrast': '高对比度',
      'chat.menu.accessibility.reduce_motion': '减少动画效果',
      'chat.menu.privacy.label': '隐私与 GDPR',
      'chat.menu.privacy.hint': '管理您的聊天数据',
      'chat.menu.privacy.note_pre': '本聊天在传输过程中已加密。聊天记录将保留 90 天以改进客服质量，之后按照我们的',
      'chat.menu.privacy.note_link': '隐私政策',
      'chat.menu.privacy.note_post': '删除。',
      'chat.menu.privacy.request_data': '申请获取我的数据副本',
      'chat.menu.privacy.delete_data': '删除我的聊天数据',
      'chat.menu.clear': '清空对话',
      'chat.close': '关闭聊天',
      'chat.loading': '正在为您接通客服…',
      'chat.remove_attachment': '移除附件',
      'chat.attach': '添加图片或文件',
      'chat.input_label': '输入消息',
      'chat.input_placeholder': '输入您的消息...',
      'chat.send': '发送消息'
    },
    ja: {
      'common.nav.overview': '概要',
      'common.nav.accounts': '口座',
      'common.nav.transactions': '取引履歴',
      'common.nav.transfers': '送金',
      'common.nav.cards': 'カード',
      'common.nav.investments': '投資',
      'common.user_menu.profile': 'プロフィール',
      'common.user_menu.settings': '設定',
      'common.user_menu.statements': '明細書',
      'common.user_menu.help': 'ヘルプセンター',
      'common.user_menu.logout': 'ログアウト',
      'common.search': '検索',
      'common.notifications': '通知',
      'common.close': '閉じる',
      'common.cancel': 'キャンセル',
      'common.save': '保存',
      'common.continue': '続ける',
      'common.back': '戻る',
      'common.edit': '編集',
      'common.remove': '削除',
      'common.confirm': '確認',
      'common.loading': '読み込み中…',
      'common.search_placeholder': '検索',
      'common.skip_to_content': 'メインコンテンツへスキップ',
      'common.menu': 'メニューを開く',
      'common.account_placeholder': 'アカウント',
      'common.try_again': '再試行',
      'common.notifications.mark_all_read': 'すべて既読にする',
      'common.notifications.empty': '新しい通知はありません。',
      'common.notifications.error': '通知を読み込めませんでした。',
      'common.notifications.view_all': 'すべての通知を見る',
      'dashboard.quick_action.send': '送金',
      'dashboard.quick_action.add_money': '入金',
      'dashboard.quick_action.invest': '投資',
      'dashboard.quick_action.request': '請求',
      'dashboard.balance.label': '合計残高（米ドル換算）',
      'dashboard.balance.manage_accounts': '口座を管理',
      'dashboard.balance.hide': '残高を非表示',
      'dashboard.balance.show': '残高を表示',
      'dashboard.account_strip.add_currency': '通貨を追加',
      'dashboard.tx.recent_title': '最近の取引',
      'dashboard.tx.view_all': 'すべて表示',
      'dashboard.spending.title': '今月の支出',
      'dashboard.spending.by_category': 'カテゴリ別',
      'dashboard.goals.title': '貯蓄目標',
      'dashboard.goals.new': '新しい目標',
      'dashboard.cards.title': 'あなたのカード',
      'dashboard.cards.manage': '管理',
      'dashboard.upsell.title': '資金を自動化',
      'dashboard.upsell.body': '定期送金や貯蓄目標を一度設定するだけで、あとはMeridianが自動で続けます。',
      'dashboard.upsell.node.account': '口座',
      'dashboard.upsell.node.autosave': '自動貯蓄',
      'dashboard.upsell.node.goal': '目標',
      'dashboard.upsell.schedule_transfer': '送金を予約',
      'dashboard.upsell.start_goal': '貯蓄目標を開始',
      'dashboard.goal_modal.title': '貯蓄目標を開始',
      'dashboard.goal_modal.subtitle': 'メイン口座から貯蓄されます。',
      'dashboard.goal_modal.name_label': '何のために貯蓄しますか？',
      'dashboard.goal_modal.name_placeholder': '例：東京旅行',
      'dashboard.goal_modal.amount_label': '目標金額',
      'dashboard.goal_modal.date_label': '目標日（任意）',
      'dashboard.goal_modal.submit': '目標を作成',
      'dashboard.ticker.aria_label': 'リアルタイム暗号資産相場',
      'dashboard.ticker.loading': '相場を読み込み中…',
      'dashboard.loading.overview': '概要を読み込み中…',
      'chat.open_support': 'サポートチャットを開く',
      'chat.status.available': '有人対応 · 24時間対応',
      'chat.options': 'チャットオプション',
      'chat.menu.sound.label': 'メッセージ音を再生',
      'chat.menu.sound.hint': '返信が届いたときに通知音を鳴らす',
      'chat.menu.sound.on': 'オン',
      'chat.menu.sound.off': 'オフ',
      'chat.menu.transcript.label': '会話履歴をダウンロード',
      'chat.menu.transcript.hint': 'この会話を.txtで保存',
      'chat.menu.accessibility.label': 'アクセシビリティ',
      'chat.menu.accessibility.hint': '文字サイズとコントラスト',
      'chat.menu.accessibility.larger_text': '文字を大きくする',
      'chat.menu.accessibility.high_contrast': 'ハイコントラスト',
      'chat.menu.accessibility.reduce_motion': 'アニメーションを減らす',
      'chat.menu.privacy.label': 'プライバシーとGDPR',
      'chat.menu.privacy.hint': 'チャットデータを管理',
      'chat.menu.privacy.note_pre': 'このチャットは通信中に暗号化されています。会話履歴はサポート向上のため90日間保管された後、削除されます。詳細は',
      'chat.menu.privacy.note_link': 'プライバシーポリシー',
      'chat.menu.privacy.note_post': 'をご覧ください。',
      'chat.menu.privacy.request_data': '自分のデータのコピーを請求する',
      'chat.menu.privacy.delete_data': '自分のチャットデータを削除する',
      'chat.menu.clear': '会話を消去',
      'chat.close': 'チャットを閉じる',
      'chat.loading': 'サポートに接続中…',
      'chat.remove_attachment': '添付ファイルを削除',
      'chat.attach': '画像またはファイルを添付',
      'chat.input_label': 'メッセージを入力',
      'chat.input_placeholder': 'メッセージを入力...',
      'chat.send': 'メッセージを送信'
    },
    ha: {
      'common.nav.overview': 'Bayyani',
      'common.nav.accounts': 'Asusun',
      'common.nav.transactions': 'Ma’amaloli',
      'common.nav.transfers': 'Aikawa Kuɗi',
      'common.nav.cards': 'Katunan',
      'common.nav.investments': 'Zuba Jari',
      'common.user_menu.profile': 'Bayanan Sirri',
      'common.user_menu.settings': 'Saituna',
      'common.user_menu.statements': 'Bayanan Asusu',
      'common.user_menu.help': 'Cibiyar Taimako',
      'common.user_menu.logout': 'Fita',
      'common.search': 'Bincike',
      'common.notifications': 'Sanarwa',
      'common.close': 'Rufe',
      'common.cancel': 'Soke',
      'common.save': 'Ajiye',
      'common.continue': 'Ci gaba',
      'common.back': 'Baya',
      'common.edit': 'Gyara',
      'common.remove': 'Cire',
      'common.confirm': 'Tabbatar',
      'common.loading': 'Ana lodawa…',
      'common.search_placeholder': 'Bincike',
      'common.skip_to_content': 'Tsallake zuwa babban abun ciki',
      'common.menu': 'Buɗe menu',
      'common.account_placeholder': 'Asusun',
      'common.try_again': 'Sake gwadawa',
      'common.notifications.mark_all_read': 'Yiwa duka alama an karanta',
      'common.notifications.empty': 'Ka gama duba komai.',
      'common.notifications.error': 'An kasa loda sanarwa.',
      'common.notifications.view_all': 'Duba dukan sanarwa',
      'dashboard.quick_action.send': 'Aika',
      'dashboard.quick_action.add_money': 'Ƙara Kuɗi',
      'dashboard.quick_action.invest': 'Zuba Jari',
      'dashboard.quick_action.request': 'Nemi Kuɗi',
      'dashboard.balance.label': 'Jimlar ma’auni, an canza zuwa USD',
      'dashboard.balance.manage_accounts': 'Sarrafa asusu',
      'dashboard.balance.hide': 'Ɓoye ma’auni',
      'dashboard.balance.show': 'Nuna ma’auni',
      'dashboard.account_strip.add_currency': 'Ƙara kuɗin ƙasa',
      'dashboard.tx.recent_title': 'Ma’amaloli na Kwanan Nan',
      'dashboard.tx.view_all': 'Duba Duka',
      'dashboard.spending.title': 'Kashe kuɗi a wannan wata',
      'dashboard.spending.by_category': 'Ta Nau’i',
      'dashboard.goals.title': 'Manufofin Ajiya',
      'dashboard.goals.new': 'Sabon Manufa',
      'dashboard.cards.title': 'Katunanka',
      'dashboard.cards.manage': 'Sarrafa',
      'dashboard.upsell.title': 'Sarrafa Kuɗinka Kai Tsaye',
      'dashboard.upsell.body': 'Saita aikawa kuɗi na yau da kullum ko manufar ajiya sau ɗaya kawai — Meridian zai ci gaba.',
      'dashboard.upsell.node.account': 'Asusun',
      'dashboard.upsell.node.autosave': 'Ajiya Kai Tsaye',
      'dashboard.upsell.node.goal': 'Manufa',
      'dashboard.upsell.schedule_transfer': 'Tsara Aikawa Kuɗi',
      'dashboard.upsell.start_goal': 'Fara Manufar Ajiya',
      'dashboard.goal_modal.title': 'Fara Manufar Ajiya',
      'dashboard.goal_modal.subtitle': 'Ana ajiyewa daga babban asusunka.',
      'dashboard.goal_modal.name_label': 'Don me kake ajiyewa?',
      'dashboard.goal_modal.name_placeholder': 'misali: Tafiya Tokyo',
      'dashboard.goal_modal.amount_label': "Adadin da aka yi niyya",
      'dashboard.goal_modal.date_label': 'Ranar da aka yi niyya (na zaɓi)',
      'dashboard.goal_modal.submit': 'Ƙirƙiri Manufa',
      'dashboard.ticker.aria_label': 'Farashin kasuwar crypto kai tsaye',
      'dashboard.ticker.loading': 'Ana loda farashin kasuwa…',
      'dashboard.loading.overview': 'Ana loda bayaninka…',
      'chat.open_support': 'Buɗe taɗi na tallafi',
      'chat.status.available': 'Wakili kai tsaye · akwai awa 24',
      'chat.options': 'Zaɓuɓɓukan taɗi',
      'chat.menu.sound.label': 'Kunna sautin saƙo',
      'chat.menu.sound.hint': 'Sauti idan an samu amsa',
      'chat.menu.sound.on': 'A kunne',
      'chat.menu.sound.off': 'A kashe',
      'chat.menu.transcript.label': 'Sauke rubutun taɗi',
      'chat.menu.transcript.hint': 'Ajiye wannan tattaunawa a matsayin .txt',
      'chat.menu.accessibility.label': 'Sauƙin amfani',
      'chat.menu.accessibility.hint': 'Girman rubutu da bambanci',
      'chat.menu.accessibility.larger_text': 'Babban rubutu',
      'chat.menu.accessibility.high_contrast': 'Bambanci mai ƙarfi',
      'chat.menu.accessibility.reduce_motion': 'Rage motsi',
      'chat.menu.privacy.label': 'Sirri da GDPR',
      'chat.menu.privacy.hint': 'Sarrafa bayanan taɗinka',
      'chat.menu.privacy.note_pre': 'An ɓoye wannan taɗi yayin aikawa. Ana ajiye rubutun tattaunawa har kwana 90 don inganta tallafi, sannan a share shi, bisa ga ',
      'chat.menu.privacy.note_link': 'manufar sirrinmu',
      'chat.menu.privacy.note_post': '.',
      'chat.menu.privacy.request_data': 'Nemi kwafin bayanaina',
      'chat.menu.privacy.delete_data': 'Share bayanan taɗina',
      'chat.menu.clear': 'Share tattaunawa',
      'chat.close': 'Rufe taɗi',
      'chat.loading': 'Ana haɗa ka da tallafi…',
      'chat.remove_attachment': 'Cire abin da aka haɗa',
      'chat.attach': 'Haɗa hoto ko takarda',
      'chat.input_label': 'Rubuta saƙo',
      'chat.input_placeholder': 'Rubuta saƙonka...',
      'chat.send': 'Aika saƙo'
    }
  };

  /* -----------------------------------------------------------
     4. Lookup helper — falls back to English, then the raw key
     ----------------------------------------------------------- */
  function t(key, lang) {
    var dict = TRANSLATIONS[lang] || TRANSLATIONS[DEFAULT_LANGUAGE];
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
    var fallback = TRANSLATIONS[DEFAULT_LANGUAGE];
    if (fallback && Object.prototype.hasOwnProperty.call(fallback, key)) return fallback[key];
    return key;
  }

  /* -----------------------------------------------------------
     5. DOM application
     ----------------------------------------------------------- */
  function applyTranslations(lang) {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'), lang);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), lang));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'), lang));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title'), lang));
    });

    var meta = SUPPORTED_LANGUAGES.find(function (l) { return l.code === lang; });
    document.documentElement.lang = lang;
    document.documentElement.dir = (meta && meta.dir) || 'ltr';
    document.documentElement.classList.toggle('is-rtl', !!(meta && meta.dir === 'rtl'));
  }

  /* -----------------------------------------------------------
     6. Language resolution
     ----------------------------------------------------------- */
  var currentLanguage = DEFAULT_LANGUAGE;

  function isSupported(code) {
    return SUPPORTED_LANGUAGES.some(function (l) { return l.code === code; });
  }

  function browserLanguageGuess() {
    var raw = (navigator.language || navigator.userLanguage || '').slice(0, 2).toLowerCase();
    return isSupported(raw) ? raw : null;
  }

  function storedExplicitChoice() {
    try {
      if (localStorage.getItem(STORAGE_KEY_SOURCE) === 'explicit') {
        var code = localStorage.getItem(STORAGE_KEY);
        if (isSupported(code)) return code;
      }
    } catch (e) { /* localStorage unavailable — ignore */ }
    return null;
  }

  function anyStoredChoice() {
    try {
      var code = localStorage.getItem(STORAGE_KEY);
      if (isSupported(code)) return code;
    } catch (e) { /* ignore */ }
    return null;
  }

  function persistChoice(code, source) {
    try {
      localStorage.setItem(STORAGE_KEY, code);
      localStorage.setItem(STORAGE_KEY_SOURCE, source);
    } catch (e) { /* ignore */ }
  }

  /**
   * setLanguage — the one function pages call to change language.
   * @param {string} code
   * @param {{persist?: boolean, source?: string}} opts
   *   persist: true  -> treated as the user's explicit choice
   *            (settings.js uses this)
   *   persist: false -> apply only, don't overwrite what's stored
   *            (used when re-applying a value already known to be
   *            the DB source of truth, e.g. right after login)
   */
  function setLanguage(code, opts) {
    opts = opts || {};
    if (!isSupported(code)) code = DEFAULT_LANGUAGE;
    currentLanguage = code;
    applyTranslations(code);
    if (opts.persist) {
      persistChoice(code, opts.source || 'explicit');
    }
  }

  /**
   * One-time IP geolocation lookup, used only when the visitor has
   * never made an explicit or even implicit language choice on this
   * browser before. Fails silently and never blocks rendering —
   * the synchronous guess (browser language / English) is applied
   * first; this only upgrades it if a better answer comes back.
   */
  function tryGeoDetect() {
    if (anyStoredChoice()) return; // never override an existing choice

    var controller = ('AbortController' in window) ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, 2500);

    fetch('https://ipapi.co/country/', { signal: controller ? controller.signal : undefined })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (countryCode) {
        clearTimeout(timeout);
        if (!countryCode) return;
        var code = COUNTRY_LANGUAGE_MAP[countryCode.trim().toUpperCase()];
        if (code && isSupported(code) && code !== currentLanguage) {
          currentLanguage = code;
          applyTranslations(code);
        }
        // Remember we've resolved a geo-based default so this
        // lookup only ever runs once per browser, not every visit.
        persistChoice(code || currentLanguage, 'geo');
      })
      .catch(function () {
        clearTimeout(timeout);
        // Network/geo lookup failed — quietly keep the synchronous
        // guess already applied (browser language or English).
        persistChoice(currentLanguage, 'geo');
      });
  }

  /* -----------------------------------------------------------
     7. Self-init on load
     ----------------------------------------------------------- */
  function init() {
    var resolved = storedExplicitChoice() || anyStoredChoice() || browserLanguageGuess() || DEFAULT_LANGUAGE;
    currentLanguage = resolved;
    applyTranslations(resolved);

    // Only attempt geo detection if nothing has ever been stored
    // for this browser at all (true first visit).
    if (!anyStoredChoice()) {
      tryGeoDetect();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* -----------------------------------------------------------
     8. Public API
     ----------------------------------------------------------- */
  window.MeridianI18n = {
    SUPPORTED_LANGUAGES: SUPPORTED_LANGUAGES,
    getLanguage: function () { return currentLanguage; },
    setLanguage: setLanguage,
    t: function (key) { return t(key, currentLanguage); },
    applyTranslations: function () { applyTranslations(currentLanguage); }
  };
})();
