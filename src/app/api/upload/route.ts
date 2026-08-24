import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { auth } from "@/auth";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, reason: "UNAUTHENTICATED" }, { status: 401 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { ok: false, reason: "UPLOAD_NOT_CONFIGURED", message: "Photo upload isn't set up on this deployment yet." },
      { status: 501 }
    );
  }

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ ok: false, reason: "INVALID_PAYLOAD" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ ok: false, reason: "UNSUPPORTED_TYPE" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, reason: "FILE_TOO_LARGE" }, { status: 400 });
  }

  const extension = file.type.split("/")[1];
  const pathname = `event-photos/${session.user.id}/${crypto.randomUUID()}.${extension}`;

  const blob = await put(pathname, file, {
    access: "public",
    contentType: file.type,
  });

  return NextResponse.json({ ok: true, url: blob.url });
}
