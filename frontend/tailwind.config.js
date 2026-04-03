/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f172a",
        panel: "#1e293b",
        gain: "#4ade80",
        loss: "#f87171",
        "snipe-bg": "#07080c",
        "snipe-panel": "#0e1118",
        "snipe-sidebar": "#080a0f",
        "snipe-border": "#1c2230",
        "snipe-accent": "#2dd4bf",
        "snipe-accent-dim": "#5eead4",
        "snipe-muted": "#64748b",
        "copy-green": "#4ade80",
        "copy-green-dim": "#22c55e",
        "copy-surface": "#0a0a0a",
        "copy-border": "#14532d"
      },
      boxShadow: {
        "copy-glow": "0 0 20px rgba(74, 222, 128, 0.12)"
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', "Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
