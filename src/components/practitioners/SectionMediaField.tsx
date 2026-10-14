'use client';

import { useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { Loader2, Upload, X } from 'lucide-react';

export type MediaMode = '' | 'embed' | 'video' | 'image';

type Props = {
  slug: string;
  practitionerId: string;
  idPrefix: string;
  initialMode: MediaMode;
  initialEmbedUrl: string;
  initialMediaUrl: string;
  initialPosterUrl: string;
  maxVideoMb: number;
  maxImageMb: number;
};

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(-100);
  return cleaned || 'file';
}

/**
 * The media half of a custom-section form. Uploads go browser -> Vercel Blob through
 * /api/practitioners/[slug]/section-media (which re-checks session, ownership, type and size on
 * the server); the resulting URLs land in hidden fields that the server action re-validates. The
 * limits shown here are a convenience only.
 */
export function SectionMediaField({
  slug,
  practitionerId,
  idPrefix,
  initialMode,
  initialEmbedUrl,
  initialMediaUrl,
  initialPosterUrl,
  maxVideoMb,
  maxImageMb,
}: Props) {
  const [mode, setMode] = useState<MediaMode>(initialMode);
  const [embedUrl, setEmbedUrl] = useState(initialEmbedUrl);
  const [mediaUrl, setMediaUrl] = useState(initialMediaUrl);
  const [posterUrl, setPosterUrl] = useState(initialPosterUrl);
  const [busy, setBusy] = useState<null | 'media' | 'poster'>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const posterInput = useRef<HTMLInputElement>(null);

  async function send(file: File, kind: 'video' | 'image' | 'poster'): Promise<string | null> {
    const isVideo = kind === 'video';
    const types = isVideo ? VIDEO_TYPES : IMAGE_TYPES;
    const limitMb = isVideo ? maxVideoMb : maxImageMb;
    if (!types.includes(file.type)) {
      setError(isVideo ? 'Use an MP4, MOV or WebM video.' : 'Use a JPG, PNG or WebP image.');
      return null;
    }
    if (file.size > limitMb * 1024 * 1024) {
      setError(`That file is over the ${limitMb} MB limit.`);
      return null;
    }
    const blob = await upload(`sections/${practitionerId}/${kind}/${safeName(file.name)}`, file, {
      access: 'public',
      handleUploadUrl: `/api/practitioners/${slug}/section-media`,
      contentType: file.type,
    });
    return blob.url;
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>, which: 'media' | 'poster') {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(which);
    setError(null);
    try {
      const kind = which === 'poster' ? 'poster' : mode === 'video' ? 'video' : 'image';
      const url = await send(file, kind);
      if (url) (which === 'poster' ? setPosterUrl : setMediaUrl)(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  }

  function changeMode(next: MediaMode) {
    setMode(next);
    setError(null);
    // A different kind of media invalidates the previous upload (the server re-checks anyway).
    if (next !== mode) {
      setMediaUrl('');
      setPosterUrl('');
    }
  }

  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60';

  return (
    <div className="space-y-2">
      <input type="hidden" name="mediaMode" value={mode} />
      <input type="hidden" name="mediaUrl" value={mode === 'video' || mode === 'image' ? mediaUrl : ''} />
      <input type="hidden" name="posterUrl" value={mode === 'video' ? posterUrl : ''} />

      <label className="block text-xs font-medium" htmlFor={`${idPrefix}-media-mode`}>
        Media (optional)
      </label>
      <select
        id={`${idPrefix}-media-mode`}
        value={mode}
        onChange={(e) => changeMode(e.target.value as MediaMode)}
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
      >
        <option value="">No media</option>
        <option value="embed">Video link (YouTube, Vimeo or Loom)</option>
        <option value="video">Upload a video (MP4, MOV or WebM)</option>
        <option value="image">Upload an image (JPG, PNG or WebP)</option>
      </select>

      {mode === 'embed' && (
        <input
          type="url"
          name="embedUrl"
          value={embedUrl}
          onChange={(e) => setEmbedUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          aria-label="Video link"
        />
      )}

      {(mode === 'video' || mode === 'image') && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={mediaInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              accept={(mode === 'video' ? VIDEO_TYPES : IMAGE_TYPES).join(',')}
              onChange={(e) => onPick(e, 'media')}
            />
            <button type="button" className={btn} disabled={busy !== null} onClick={() => mediaInput.current?.click()}>
              {busy === 'media' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
              {mediaUrl ? 'Replace file' : mode === 'video' ? 'Choose video' : 'Choose image'}
            </button>
            <span className="text-[11px] text-muted-foreground">
              {mediaUrl ? 'File attached. Save to keep it.' : `Up to ${mode === 'video' ? maxVideoMb : maxImageMb} MB.`}
            </span>
          </div>

          {mode === 'video' && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={posterInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                accept={IMAGE_TYPES.join(',')}
                onChange={(e) => onPick(e, 'poster')}
              />
              <button type="button" className={btn} disabled={busy !== null} onClick={() => posterInput.current?.click()}>
                {busy === 'poster' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Upload className="h-3.5 w-3.5" aria-hidden />}
                {posterUrl ? 'Replace cover image' : 'Cover image (optional)'}
              </button>
              {posterUrl && (
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setPosterUrl('')}>
                  <X className="mr-1 inline h-3 w-3" aria-hidden />
                  Remove cover
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
