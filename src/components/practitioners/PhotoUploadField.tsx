'use client';

import { useRef, useState } from 'react';
import Image from 'next/image';
import { upload } from '@vercel/blob/client';
import { Loader2, Upload, X } from 'lucide-react';

type Props = {
  slug: string;
  /** Current photoUrl (Vercel Blob URL or local /practitioners/* path). */
  initial: string | null;
};

/**
 * Profile-photo upload control (Wedge P1 / Task A). Uploads the chosen image
 * straight to Vercel Blob from the browser via the client-upload flow, then
 * writes the resulting blob URL into a hidden `photoUrl` field so the edit
 * form's server action persists it onto Practitioner.photoUrl.
 *
 * The whole edit page is a server component, so this island owns the upload
 * state. Clearing the photo submits an empty `photoUrl` (server action nulls it).
 */
export function PhotoUploadField({ slug, initial }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(initial);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('uploading');
    setError(null);
    try {
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: `/api/practitioners/${slug}/photo`,
      });
      setUrl(blob.url);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      // Allow re-selecting the same file after an error.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const clear = () => {
    setUrl(null);
    setStatus('idle');
    setError(null);
  };

  return (
    <div className="space-y-2">
      {/* The persisted value the server action reads. Empty string clears it. */}
      <input type="hidden" name="photoUrl" value={url ?? ''} />

      <div className="flex items-center gap-4">
        <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full border bg-muted">
          {url ? (
            <Image
              src={url}
              alt="Profile photo preview"
              fill
              sizes="80px"
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground">
              No photo
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={status === 'uploading'}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
            >
              {status === 'uploading' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-3.5 w-3.5" aria-hidden />
              )}
              {status === 'uploading' ? 'Uploading…' : url ? 'Replace photo' : 'Upload photo'}
            </button>
            {url && status !== 'uploading' && (
              <button
                type="button"
                onClick={clear}
                className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Remove
              </button>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            JPG, PNG, WebP or GIF · up to 8MB. A clear headshot works best.
          </p>
          {error && <p className="text-[11px] text-destructive">{error}</p>}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={onFileChange}
        className="sr-only"
      />
    </div>
  );
}
