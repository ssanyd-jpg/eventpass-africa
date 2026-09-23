"use client";

import { useEffect, useState } from "react";

// Session E — "appears after an attendee's second visit" (spec item 3).
// Visit count persists across sessions (localStorage); the per-tab guard
// (sessionStorage) stops a single visit incrementing it once per route
// change as the attendee clicks around the SPA.
const VISIT_COUNT_KEY = "eventpass-africa:visit-count";
const DISMISSED_KEY = "eventpass-africa:install-prompt-dismissed";
const SESSION_COUNTED_KEY = "eventpass-africa:visit-counted-this-session";
const MIN_VISITS_BEFORE_PROMPT = 2;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own non-standard flag — matchMedia above doesn't cover it.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const [ios, setIos] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISSED_KEY) === "1") return;

    let count = parseInt(localStorage.getItem(VISIT_COUNT_KEY) ?? "0", 10);
    if (!sessionStorage.getItem(SESSION_COUNTED_KEY)) {
      count += 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(count));
      sessionStorage.setItem(SESSION_COUNTED_KEY, "1");
    }
    if (count < MIN_VISITS_BEFORE_PROMPT) return;

    setIos(isIOS());
    setVisible(true);
  }, []);

  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    dismiss();
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Add Chaap to your home screen"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-30 mx-auto max-w-sm rounded-2xl border border-border bg-surface p-4 shadow-lg shadow-black/40 md:bottom-4"
    >
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.svg" alt="" className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Add Chaap to your home screen</p>
          {ios ? (
            <p className="mt-1 text-sm text-muted">
              Tap <span className="font-semibold text-foreground">Share</span>{" "}
              <span aria-hidden="true">⎋</span>, then{" "}
              <span className="font-semibold text-foreground">&quot;Add to Home Screen&quot;</span>.
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">
              Get one-tap access to your tickets and wallet — works offline too.
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {!ios && deferredPrompt && (
              <button type="button" onClick={install} className="btn-primary min-h-9 !px-4 text-sm">
                Install
              </button>
            )}
            <button type="button" onClick={dismiss} className="btn-secondary min-h-9 !px-4 text-sm">
              Not now
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface2 hover:text-foreground"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
