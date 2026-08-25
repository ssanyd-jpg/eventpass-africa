"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/use-translation";

// Same progressive-enhancement philosophy as CameraScanner: uses the native
// Web NFC API (NDEFReader — Chrome for Android only) and simply renders
// nothing if the browser doesn't support it. Reading must start inside a
// user-gesture handler (a Web NFC requirement), hence the explicit button
// rather than auto-starting like the camera loop does.
interface NDEFRecordLike {
  recordType: string;
  encoding?: string;
  data?: DataView;
}
interface NDEFReadingEvent {
  message: { records: NDEFRecordLike[] };
}
interface NDEFReaderLike {
  scan(): Promise<void>;
  onreading: ((event: NDEFReadingEvent) => void) | null;
  onreadingerror: (() => void) | null;
}

declare global {
  interface Window {
    NDEFReader?: new () => NDEFReaderLike;
  }
}

export default function NFCScanner({ onDetect }: { onDetect: (code: string) => void }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastDetectionRef = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "NDEFReader" in window);
  }, []);

  async function startScan() {
    setError(null);
    try {
      const reader = new window.NDEFReader!();
      await reader.scan();
      reader.onreading = (event) => {
        const record = event.message.records.find((r) => r.recordType === "text");
        if (!record?.data) return;
        // Text records are prefixed with a status byte + language code
        // (e.g. "en") before the actual payload — skip past it.
        const languageCodeLength = record.data.getUint8(0) & 0x3f;
        const textBytes = new Uint8Array(record.data.buffer, record.data.byteOffset + 1 + languageCodeLength);
        const value = new TextDecoder().decode(textBytes).trim();
        if (!value) return;
        const now = Date.now();
        const last = lastDetectionRef.current;
        // debounce: ignore the same tag re-read within 3s (a tag left in
        // range fires onreading repeatedly, same problem the camera loop has)
        if (!last || last.code !== value || now - last.at > 3000) {
          lastDetectionRef.current = { code: value, at: now };
          onDetect(value);
        }
      };
      reader.onreadingerror = () => setError("Couldn't read that tag — try again.");
      setActive(true);
    } catch {
      setError("Couldn't start NFC scanning — check permissions, or use manual entry below.");
    }
  }

  if (!supported) return null;

  return (
    <div className="mb-4">
      <button type="button" className="btn-secondary w-full" onClick={active ? () => setActive(false) : startScan}>
        {active ? t("scan.stopNfcScan") : t("scan.scanWithNfc")}
      </button>
      {active && <p className="mt-2 text-sm text-muted">Hold a wristband near the back of the device.</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
