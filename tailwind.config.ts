import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        surface: "var(--surface)",
        surface2: "var(--surface-2)",
        border: "var(--border)",
        muted: "var(--muted)",
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          soft: "var(--accent-soft)",
        },
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        "helix-blue": "var(--helix-blue)",
        "deep-blue": "var(--deep-blue)",
        crimson: "var(--crimson-red)",
        silver: "var(--silver)",
        gunmetal: "var(--gunmetal)",
      },
      fontFamily: {
        sans: ["var(--font-montserrat)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)"],
        // Brand primary face "Helium" — falls back to the bundled
        // Montserrat (extra bold) where Helium isn't installed locally.
        display: ["Helium", "var(--font-montserrat)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
