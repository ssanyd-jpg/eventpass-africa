import { NextResponse } from "next/server";
import QRCode from "qrcode";

// Public, unauthenticated QR image for a ticket — the code itself is the
// credential (same trust model as the in-app QR in TicketQr.tsx), so no
// session or DB lookup is needed here. Exists so email clients that strip
// data: URIs (Gmail blocks inline base64 images in HTML mail) still render
// the QR, by hosting it as a real image URL instead.
//
// The dynamic segment is named [ticketId] (not [code]) only because Next.js
// requires every route sharing this path position (see ../resale/route.ts)
// to use the same slug name — the value it carries is actually the ticket's
// `code` field, not its DB id, and the URL path itself is unaffected either
// way: /api/tickets/<code>/qr.png.
export async function GET(_request: Request, { params }: { params: { ticketId: string } }) {
  const code = params.ticketId;
  const buffer = await QRCode.toBuffer(code, { margin: 1, width: 180 });
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
