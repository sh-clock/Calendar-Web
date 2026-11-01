/**
 * boot-guard.js — runs BEFORE first paint as a blocking head script
 * (CSP-clean: same-origin file, script-src 'self').
 *
 * 1. FRAME-BUST (sec-S5-F3): GitHub Pages cannot set X-Frame-Options /
 *    frame-ancestors headers, and <meta> CSP frame-ancestors is ignored by
 *    spec — so the JS guard is the primary mitigation. The live site was
 *    verified FULLY interactive inside a third-party iframe (clickjacking
 *    of the unlock + destructive flows); this escapes the frame, or hides
 *    everything when escaping is blocked (sandboxed iframe without
 *    allow-top-navigation).
 * 2. THEME-BOOT (FOUC guard, moved verbatim from the old inline <script>):
 *    decide light/dark + the active FullCalendar theme attributes BEFORE
 *    first paint. Precedence (F-A3-2/F-A5-1, audit wave): v45 settings
 *    theme (light/dark) > [no settings yet] legacy v44/v4.3 keys > OS
 *    preference. A settings value of 'system' ALWAYS follows the OS.
 */
(function () {
  'use strict';

  /* ---- 1. frame-bust — before ANY content renders ---- */
  try {
    if (self !== top) {
      // Escape: navigate the top window to ourselves. Modern browsers allow
      // a cross-origin child to set top.location (classic frame-busting).
      top.location = self.location;
      // If the assignment above throws (sandbox without allow-top-navigation,
      // or an unusual embedding), deny the attacker any pixels instead.
      throw new Error('framed');
    }
  } catch (e) {
    // Hide everything and keep it hidden. The stylesheet-level hiding cannot
    // be undone by the embedder because this element stays in <head>.
    var st = document.createElement('style');
    st.textContent = 'html{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(st);
    return; // no point painting a framed app
  }

  /* ---- 2. theme boot (FOUC guard) ---- */
  try {
    var t = null;
    var raw = null;
    var s = null;
    try { raw = localStorage.getItem('clock_poc_settings_v45'); } catch (e) {}
    if (!raw) { try { raw = localStorage.getItem('clock_poc_settings_v44'); } catch (e) {} }
    try { s = raw ? JSON.parse(raw) : null; } catch (e) { s = null; }
    if (s && (s.theme === 'light' || s.theme === 'dark')) {
      t = s.theme;
    } else if (!s || !s.theme) {
      // No settings (or no theme field): legacy migration sources.
      var l = null;
      try { l = localStorage.getItem('clock_poc_theme'); } catch (e) {}
      if (l === 'light' || l === 'dark') t = l;
    }
    // t === null here means 'system' or nothing known → follow the OS.
    if (t === null) {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var d = document.documentElement;
    d.dataset.theme = t;
    d.dataset.colorScheme = t; // drives the official FC theme + shadcn/MUI dark blocks
    // Theme attributes: the calendar theme + palette drive the managed
    // CSS links (app.js applyFcThemeAssets); setting data-fctheme early
    // keeps chrome-token selectors correct from the first paint.
    var theme = s && typeof s.fcTheme === 'string' ? s.fcTheme : 'monarch';
    var themes = { monarch: 1, forma: 1, breezy: 1, pulse: 1, classic: 1, shadcn: 1, mui: 1 };
    if (!themes[theme]) theme = 'monarch';
    d.dataset.fctheme = theme;
    if (theme === 'shadcn') d.dataset.palette = (s && typeof s.fcPalette === 'string') ? s.fcPalette : 'neutral';
    if (theme === 'mui') d.dataset.muiPalette = (s && typeof s.fcPalette === 'string') ? s.fcPalette : 'blue';
  } catch (e) { /* private mode etc. */ }
})();
