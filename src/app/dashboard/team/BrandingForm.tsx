"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_SWATCH = "#FF6A00";

// Session 39 — Case A organiser branding settings. Deliberately minimal:
// three independent fields (name, color, logo), each clearable back to
// "use Chaap's default branding" on its own. No preview of where these
// currently apply — see the branding investigation for which surfaces are
// wired up today (email "from" name, the order-confirmation share text)
// versus stored-but-not-yet-rendered (logo, color — the one place they'd
// show, the shared Navbar, has no per-organiser context at render time).
export default function BrandingForm({
  initial,
}: {
  initial: { displayName: string; brandColor: string; logoUrl: string };
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [brandColor, setBrandColor] = useState(initial.brandColor);
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onLogoChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    setUploading(false);
    if (!res.ok || !data.ok) {
      setError(data.message ?? "Couldn't upload that logo.");
      return;
    }
    setLogoUrl(data.url);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await fetch("/api/organization/branding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, brandColor, logoUrl }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Couldn't save branding.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-4 p-5">
      <div>
        <h2 className="font-semibold">Branding</h2>
        <p className="text-xs text-muted">
          Show your own name and logo to attendees instead of Chaap&apos;s. Leave a field blank to keep Chaap&apos;s default.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="brand-display-name">Display name</label>
        <input
          id="brand-display-name"
          type="text"
          maxLength={60}
          placeholder="Chaap"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>

      <div>
        <span className="label">Brand color</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick brand color"
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
            value={/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : DEFAULT_SWATCH}
            onChange={(e) => setBrandColor(e.target.value)}
          />
          <input
            type="text"
            placeholder="#FF6A00"
            className="input flex-1"
            value={brandColor}
            onChange={(e) => setBrandColor(e.target.value)}
          />
          {brandColor && (
            <button type="button" className="text-xs font-medium text-muted hover:text-foreground" onClick={() => setBrandColor("")}>
              Clear
            </button>
          )}
        </div>
      </div>

      <div>
        <span className="label">Logo</span>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-12 w-12 rounded-lg border border-border object-cover" />
          ) : (
            <div className="h-12 w-12 rounded-lg border border-dashed border-border" />
          )}
          <button
            type="button"
            className="btn-secondary text-xs"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
          </button>
          {logoUrl && (
            <button type="button" className="text-xs font-medium text-muted hover:text-foreground" onClick={() => setLogoUrl("")}>
              Remove
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={onLogoChosen}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving || uploading} className="btn-primary">
          {saving ? "Saving…" : "Save branding"}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
        {saved && !error && <p className="text-sm text-ok">Saved.</p>}
      </div>
    </form>
  );
}
