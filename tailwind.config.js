// Palette points at the shared Hoard tokens (src/hoard-theme.css); the alpha
// placeholder keeps Tailwind opacity modifiers (bg-ink-900/50) working.
const tok = (name) => `color-mix(in srgb, var(--hoard-${name}) calc(<alpha-value> * 100%), transparent)`;
const mix = (a, b, pct) => `color-mix(in srgb, color-mix(in srgb, var(--hoard-${a}) ${100 - pct}%, var(--hoard-${b}) ${pct}%) calc(<alpha-value> * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['var(--hoard-font-serif)'],
        body: ['var(--hoard-font-sans)'],
        mono: ['var(--hoard-font-mono)'],
      },
      colors: {
        ink: {
          50:  mix('text', 'accent-ink', 0),
          100: tok('text'),
          200: mix('text', 'text-muted', 50),
          300: tok('text-muted'),
          400: tok('text-dim'),
          500: mix('text-dim', 'border-hover', 50),
          600: tok('border-hover'),
          700: tok('border'),
          800: tok('elevated'),
          900: tok('surface'),
          950: tok('deep'),
        },
        amber: {
          50:  mix('accent', 'text', 85),
          100: mix('accent', 'text', 70),
          200: mix('accent', 'text', 50),
          300: mix('accent', 'text', 30),
          400: tok('accent-strong'),
          500: tok('accent'),
          600: tok('accent-dim'),
          700: mix('accent-dim', 'deep', 35),
          800: mix('accent-dim', 'deep', 60),
          900: mix('accent-dim', 'deep', 80),
        },
        sage: {
          400: '#86a884',
          500: '#6b9c69',
          600: '#4d7a4b',
        },
        rose: {
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
        }
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s infinite',
        'slide-in-right': 'slideInRight 0.25s ease-out',
        'slide-in-left': 'slideInLeft 0.25s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
      }
    },
  },
  plugins: [],
}
