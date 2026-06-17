/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Georgia', 'Cambria', 'serif'],
        ui: ['Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 14px 28px rgba(0,0,0,0.28)',
        felt: 'inset 0 0 60px rgba(0,0,0,0.5), 0 24px 80px rgba(0,0,0,0.38)',
      },
    },
  },
  plugins: [],
};
