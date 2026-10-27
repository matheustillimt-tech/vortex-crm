/** @type {import('tailwindcss').Config} */

// Cores que mudam com a identidade visual (data-brand no <html>) saem de variáveis CSS
// em canais RGB, para continuar aceitando opacidade (ex.: bg-violet-500/15).
const rgb = (name) => `rgb(var(--${name}) / <alpha-value>)`
const scale = (prefix, steps) => Object.fromEntries(steps.map((s) => [s, rgb(`${prefix}-${s}`)]))
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      colors: {
        // escala "violet" = cor de marca do tema ativo (roxo no Violeta, verdes no Fósforo)
        violet: scale('v', STEPS),
        fuchsia: { 600: rgb('fuchsia-600') },
        blue: { 300: rgb('blue-300'), 400: rgb('blue-400'), 500: rgb('blue-500') },
        // tons usados como texto de status: mais claros no escuro, mais escuros no claro (contraste)
        green: { 300: rgb('green-300'), 400: rgb('green-400') },
        red: { 300: rgb('red-300'), 400: rgb('red-400') },
        amber: { 300: rgb('amber-300'), 400: rgb('amber-400') },
        surface: {
          base: 'var(--surface-base)',
          sidebar: 'var(--surface-sidebar)',
          raised: 'var(--surface-raised)',
          overlay: 'var(--surface-overlay)',
          interactive: 'var(--surface-interactive)',
          canvas: 'var(--surface-flow-canvas)',
        },
        border: {
          DEFAULT: 'var(--border-default)',
          hover: 'var(--border-hover)',
          subtle: 'var(--border-subtle)',
        },
        accent: {
          primary: rgb('accent'),
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
          fg: 'var(--accent-fg)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
      },
      boxShadow: {
        glow: 'var(--shadow-glow)',
        'glow-lg': 'var(--shadow-glow-lg)',
      },
    },
  },
  plugins: [],
}
