/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0f172a",
        panel: "#1e293b",
        gain: "#4ade80",
        loss: "#f87171"
      }
    }
  },
  plugins: []
};
