"use client";

import { useEffect } from "react";

// Session E — spec item 5 ("payment form and checkout forms don't get
// obscured by the mobile keyboard"). Applied globally rather than wired
// into individual forms: the mobile on-screen keyboard covering the
// bottom third of the viewport is a problem for every text input in the
// app, not just checkout, and a single focus listener here is far less
// fragile than remembering to add scroll-into-view to every form going
// forward. The delay lets the keyboard's own slide-in animation finish
// first — scrolling immediately on focus races it on iOS Safari and
// Android Chrome alike, landing short of where the input ends up.
const KEYBOARD_ANIMATION_DELAY_MS = 300;
const FOCUSABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export default function KeyboardAwareScroll() {
  useEffect(() => {
    function onFocusIn(e: FocusEvent) {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !FOCUSABLE_TAGS.has(target.tagName)) return;
      setTimeout(() => {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }, KEYBOARD_ANIMATION_DELAY_MS);
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  return null;
}
