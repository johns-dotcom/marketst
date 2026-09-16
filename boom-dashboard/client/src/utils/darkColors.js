// Shared dark mode color palette for inline-styled bookkeeping pages.
// Usage: const C = getDarkColors()
//
// Design-system migration note: this file is the JS mirror of the CSS
// variables in `src/styles/tokens.css`. When adding or changing a token,
// update both — otherwise className-styled pages (bg-card / text-ink)
// and inline-styled pages (style={{ background: C.cardBg }}) drift.
// Existing keys are preserved exactly; only additive keys may be added.

export default function getDarkColors(themeOverride) {
  const isDark = themeOverride === 'dark' || (!themeOverride && document.documentElement.classList.contains('dark'))

  const common = {
    // Brand — same in both themes
    brand:       '#334155',
    brandHover:  '#1E293B',
    brandActive: '#0F172A',
    brandMuted:  'rgba(51, 65, 85,0.08)',

    // Semantic status — same hues, theme-appropriate intensity
    success: isDark ? '#34d399' : '#059669',
    warning: isDark ? '#fbbf24' : '#d97706',
    danger:  isDark ? '#fca5a5' : '#dc2626',
    info:    isDark ? '#60a5fa' : '#2563eb',
  }

  return isDark ? {
    ...common,
    isDark: true,
    // Values mirror the tokens.css softer-dark repaint (warmer grays;
    // the old near-black #0f1117 base clashed with the brand red).
    pageBg: '#131520', cardBg: '#1c1f2b', elevBg: '#232734',
    border: '#2e3340', borderLight: '#1f222c',
    text: '#e0e2e8', textMuted: '#8a8f9f', textFaint: '#555b6e',
    thBg: '#161824', thText: '#6b7085', thBorder: '#1f222c',
    tdBorder: '#1f222c',
    rowBg: '#1c1f2b', rowHover: '#232734',
    inputBg: '#232734', inputText: '#e0e2e8', inputBorder: '#2e3340',
    selectBg: '#232734',
    shadow: '0 8px 32px rgba(0,0,0,.4)',
    badgeYesBg: 'rgba(16,185,129,.12)', badgeYesText: '#6ee7b7',
    badgeNoBg: 'rgba(239,68,68,.1)', badgeNoText: '#fca5a5',
    badgeNeutralBg: '#1f222c', badgeNeutralText: '#8a8f9f',
    linkColor: '#60a5fa',

    // Additive — chrome/overlay tokens, no existing consumer relies on these.
    sidebarBg: '#161824',
    sidebarBorder: '#1f222c',
    headerBg: '#131520',
    overlayBg: 'rgba(0,0,0,0.6)',
    focusRing: 'rgba(51, 65, 85,0.35)',
    divider: '#1f222c',
  } : {
    ...common,
    isDark: false,
    pageBg: '#f4f4f4', cardBg: '#fff', elevBg: '#fafafa',
    border: '#e2e2e2', borderLight: '#f3f4f6',
    text: '#111', textMuted: '#777', textFaint: '#9ca3af',
    thBg: '#f8f9fa', thText: '#9ca3af', thBorder: '#e2e2e2',
    tdBorder: '#f3f4f6',
    rowBg: '#fff', rowHover: '#fafafa',
    inputBg: '#fff', inputText: '#111', inputBorder: '#e2e2e2',
    selectBg: '#fff',
    shadow: '0 8px 32px rgba(0,0,0,.12)',
    badgeYesBg: '#d1fae5', badgeYesText: '#065f46',
    badgeNoBg: '#fee2e2', badgeNoText: '#991b1b',
    badgeNeutralBg: '#f3f4f6', badgeNeutralText: '#6b7280',
    linkColor: '#334155',

    // Additive — chrome/overlay tokens.
    sidebarBg: '#ffffff',
    sidebarBorder: '#e5e7eb',
    headerBg: '#ffffff',
    overlayBg: 'rgba(17,24,39,0.5)',
    focusRing: 'rgba(51, 65, 85,0.25)',
    divider: '#f3f4f6',
  }
}
