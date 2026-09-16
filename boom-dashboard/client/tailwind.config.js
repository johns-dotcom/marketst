export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        // --- Existing palettes — referenced in hundreds of places, do not rename. ---
        // `boom` is the ACCENT palette. The name is load-bearing (hundreds of
        // `text-boom-600` etc. call sites) — swap the VALUES for the real
        // Market Street brand colour when there is one. Placeholder: slate.
        boom: {
          DEFAULT: '#334155',
          50: '#F8FAFC',
          100: '#F1F5F9',
          200: '#E2E8F0',
          300: '#CBD5E1',
          400: '#94A3B8',
          500: '#64748B',
          600: '#334155',
          700: '#1E293B',
          800: '#0F172A',
          900: '#0B1120',
          950: '#020617',
        },
        surface: {
          0: '#FFFFFF',
          50: '#F9FAFB',
          100: '#F3F4F6',
          200: '#E5E7EB',
        },

        // Theme-aware gray palette. Light values match Tailwind v3 defaults;
        // dark values mirror the legacy `.dark .text-gray-*` / `.bg-gray-*` /
        // `.border-gray-*` !important overrides that used to live in
        // index.css. Expressed as `rgb(var(--…) / <alpha-value>)` so opacity
        // modifiers (bg-gray-50/80, text-gray-400/60, etc.) keep working.
        gray: {
          50:  'rgb(var(--color-gray-50)  / <alpha-value>)',
          100: 'rgb(var(--color-gray-100) / <alpha-value>)',
          200: 'rgb(var(--color-gray-200) / <alpha-value>)',
          300: 'rgb(var(--color-gray-300) / <alpha-value>)',
          400: 'rgb(var(--color-gray-400) / <alpha-value>)',
          500: 'rgb(var(--color-gray-500) / <alpha-value>)',
          600: 'rgb(var(--color-gray-600) / <alpha-value>)',
          700: 'rgb(var(--color-gray-700) / <alpha-value>)',
          800: 'rgb(var(--color-gray-800) / <alpha-value>)',
          900: 'rgb(var(--color-gray-900) / <alpha-value>)',
        },

        // --- Semantic aliases backed by CSS variables in styles/tokens.css. ---
        // Use these in NEW code. Do NOT bulk-rewrite existing bg-white /
        // bg-gray-50 usages — those migrate per-page via the PR plan.
        page:    'var(--color-bg-page)',
        card:    'var(--color-bg-card)',
        elev:    'var(--color-bg-elev)',
        sidebar: 'var(--color-bg-sidebar)',
        header:  'var(--color-bg-header)',

        ink:         'var(--color-text)',
        'ink-muted': 'var(--color-text-muted)',
        'ink-faint': 'var(--color-text-faint)',

        rule:         'var(--color-border)',
        'rule-light': 'var(--color-border-light)',
        divider:      'var(--color-divider)',

        row:         'var(--color-row)',
        'row-hover': 'var(--color-row-hover)',

        'input-bg':     'var(--color-input-bg)',
        'input-border': 'var(--color-input-border)',
        'input-text':   'var(--color-input-text)',

        'th-bg':   'var(--color-th-bg)',
        'th-text': 'var(--color-th-text)',

        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger:  'var(--color-danger)',
        info:    'var(--color-info)',

        brand:          'var(--color-brand)',
        'brand-hover':  'var(--color-brand-hover)',
        'brand-active': 'var(--color-brand-active)',
        'brand-muted':  'var(--color-brand-muted)',
        overlay:        'var(--color-overlay)',

        // Deliberately NOT named `rose` / `amber`. Those are real Tailwind
        // palettes and a key here REPLACES the whole scale — naming this one
        // `rose` would delete rose-50…900 and silently break the 340+
        // text-rose-600 / bg-rose-50 usages already in the client. These are
        // semantic aliases with their own names, and they coexist.
        //
        // alert = something is WRONG (the house rule for red; not "this button
        // deletes"). diff = these two things differ HERE, which is information
        // rather than a problem, hence amber and not red.
        alert:      'var(--color-rose)',
        'alert-bg': 'var(--color-rose-bg)',
        'alert-bd': 'var(--color-rose-bd)',
        diff:       'var(--color-diff-bd)',
        'diff-bg':  'var(--color-diff-bg)',
        'diff-bd':  'var(--color-diff-bd)',
      },
      boxShadow: {
        'xs': '0 1px 2px 0 rgb(0 0 0 / 0.03)',
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'elevated': '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05)',
        'modal': '0 20px 25px -5px rgb(0 0 0 / 0.08), 0 8px 10px -6px rgb(0 0 0 / 0.08)',
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
      }
    },
  },
  plugins: [],
}
