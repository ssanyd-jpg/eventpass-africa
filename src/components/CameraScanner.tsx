"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/use-translation";

// Strictly a progressive enhancement on top of manual code entry: uses the
// native BarcodeDetector API (no decoding library — Chrome on Android, the
// target device class here, has broad support via ML Kit) and simply does
// nothing if the browser doesn't support it, or if camera access fails.
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export default function CameraScanner({ onDetect }: { onDetect: (code: string) => void }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastDetectionRef = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "BarcodeDetector" in window);
  }, []);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const detector = new window.BarcodeDetector!({ formats: ["qr_code"] });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue;
            if (value) {
              const now = Date.now();
              const last = lastDetectionRef.current;
              // debounce: ignore the same code re-detected within 3s
              if (!last || last.code !== value || now - last.at > 3000) {
                lastDetectionRef.current = { code: value, at: now };
                onDetect(value);
              }
            }
          } catch {
            // detection hiccup — keep the loop alive
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't access the camera — check permissions, or use manual entry below.");
      });

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [active, onDetect]);

  if (!supported) return null;

  return (
    <div className="mb-4">
      <button type="button" className="btn-secondary w-full" onClick={() => setActive((a) => !a)}>
        {active ? t("scan.stopCameraScan") : t("scan.scanWithCamera")}
      </button>
      {active && (
        <div className="mt-3 overflow-hidden rounded-xl border border-border">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={videoRef} className="aspect-video w-full bg-black object-cover" muted playsInline />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
