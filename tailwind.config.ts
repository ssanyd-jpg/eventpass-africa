import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    // EVENT_TYPE_BADGE_COLORS (src/lib/marketplace.ts) holds Tailwind class
    // strings that are only ever referenced dynamically (never typed out in
    // a component/app file) — without src/lib in the scan path, Tailwind's
    // JIT never sees those literal class names and silently never generates
    // the CSS for them, so every event-type badge rendered with no color at
    // all despite the "right" classes being applied. Same failure mode
    // could hit any other dynamic-class lib file, hence scanning all of lib.
    "./src/lib/**/*.{js,ts,jsx,tsx}",
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
        heading: "var(--text-heading)",
        "on-chrome": "var(--text-on-chrome)",
        "chrome-border": "var(--chrome-border)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        "helix-blue": "var(--helix-blue)",
        "deep-blue": "var(--deep-blue)",
        crimson: "var(--crimson-red)",
        silver: "var(--silver)",
        gunmetal: "var(--gunmetal)",
      },
      // Sunset theme gradients — the layered scrim + gradient values live in
      // globals.css as --chrome-*-bg / --accent-gradient.
      backgroundImage: {
        "chrome-topbar": "var(--chrome-topbar-bg)",
        "chrome-sidebar": "var(--chrome-sidebar-bg)",
        "accent-gradient": "var(--accent-gradient)",
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
