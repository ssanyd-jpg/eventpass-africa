"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Encodes only the raw ticket code (not a URL) — keeps the payload short for
// denser, more reliable scans on low-end cameras, and means the scanner's
// checkIn(code) logic needs no changes: the QR is just an alternate input
// feeding the same short code as manual entry.
export default function TicketQr({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(code, { type: "svg", margin: 1, color: { dark: "#0d0d0d", light: "#f2f2f2" } }).then(
      (result) => {
        if (!cancelled) setSvg(result);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!svg) {
    return <div className="aspect-square w-full max-w-[180px] animate-pulse rounded-lg bg-surface2" />;
  }

  return (
    <div
      className="w-full max-w-[180px] overflow-hidden rounded-lg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
