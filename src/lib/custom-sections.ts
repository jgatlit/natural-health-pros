import sanitizeHtml from 'sanitize-html';

/**
 * L1b - practitioner-authored profile sections ("custom sections"). Everything that decides what
 * is allowed to be stored or rendered lives here as pure functions, so the security properties
 * are testable without a database or a browser.
 *
 * Distinct from `profile-sections.ts`, which only holds the Qualifications heading.
 */

// ---- Configuration -------------------------------------------------------------------------

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SECTION_TITLE_MAX = 80;
export const SECTION_CAPTION_MAX = 200;
export const SECTION_BODY_MAX = 20_000;

/** Per-practitioner cap. Amy floated 3; the task default is 6. */
export function maxSections(): number {
  return intEnv('PROFILE_SECTIONS_MAX', 6);
}
export function maxVideoBytes(): number {
  return intEnv('PROFILE_SECTION_VIDEO_MAX_MB', 100) * 1024 * 1024;
}
export function maxImageBytes(): number {
  return intEnv('PROFILE_SECTION_IMAGE_MAX_MB', 10) * 1024 * 1024;
}

/**
 * Testimonial attestation checkbox. Operator default is OFF: the flag exists, the shipped value is
 * off. Amy's testimonial-authenticity policy is still pending.
 */
export const TESTIMONIAL_ATTESTATION_ENABLED = process.env.PROFILE_SECTIONS_TESTIMONIAL_ATTESTATION === 'true';

export function mentionsTestimonial(...parts: Array<string | null | undefined>): boolean {
  // Deliberately a stub (flag ships OFF): catches the obvious spellings only, not a determined
  // author. Strips tags first so markup cannot split the word.
  return parts.some((p) =>
    /testimonials?|(client|patient|customer)\s+reviews?|success\s+stor(y|ies)/i.test(
      (p ?? '').replace(/<[^>]*>/g, ''),
    ),
  );
}

export const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

export type MediaKind = 'EMBED' | 'VIDEO_UPLOAD' | 'IMAGE_UPLOAD';
export type EmbedProvider = 'YOUTUBE' | 'VIMEO' | 'LOOM';
export type UploadKind = 'video' | 'image' | 'poster';

// ---- Text ----------------------------------------------------------------------------------

/** Plain-text field: strip control characters, collapse whitespace. Escaping happens in React. */
export function cleanPlain(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const ALLOWED_TAGS = ['p', 'br', 'h3', 'h4', 'strong', 'em', 'u', 'ul', 'ol', 'li', 'blockquote', 'a'];

/**
 * Allowlist sanitizer for the text block. Run on save AND on render.
 *
 * https links only; every anchor is forced to rel="nofollow noopener" target="_blank". Script /
 * style / textarea / option contents are discarded (not unwrapped), so `<script>alert(1)</script>`
 * leaves no text behind. No images, iframes, classes, ids or inline styles survive. The function is
 * idempotent: sanitize(sanitize(x)) === sanitize(x), so sanitizing again at render is safe.
 */
export function sanitizeSectionHtml(raw: string | null | undefined): string {
  const input = String(raw ?? '').slice(0, SECTION_BODY_MAX * 2);
  const out = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'rel', 'target'] },
    allowedSchemes: ['https'],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      // A link without a plain https href is turned into a `span`, which is not allowed, so the
      // tag is discarded and its text kept (no dangling <a> without href). The library's own
      // scheme filter still runs afterwards on the links that pass this check.
      a: (tagName, attribs) =>
        /^https:\/\/\S/i.test((attribs.href ?? '').trim())
          ? { tagName, attribs: { href: attribs.href.trim(), rel: 'nofollow noopener', target: '_blank' } }
          : { tagName: 'span', attribs: {} as Record<string, string> },
    },
  });
  return out.trim().slice(0, SECTION_BODY_MAX);
}

/** True when the sanitized block has no visible content (e.g. only a stripped script). */
export function isEmptyHtml(html: string | null | undefined): boolean {
  return !html || sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim() === '';
}

// ---- Embeds --------------------------------------------------------------------------------

export type ParsedEmbed = { provider: EmbedProvider; id: string };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^[0-9]{5,12}$/;
const LOOM_ID = /^[a-f0-9]{32}$/;

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

/**
 * Parse a pasted URL against the provider allowlist. Hostnames are compared EXACTLY after URL
 * parsing (so `youtube.com.evil.com`, `evil.com/youtube.com` and `youtube.com@evil.com` are all
 * rejected), https only, and each id must match a strict regex. Returns provider + id only; the
 * iframe src is rebuilt by {@link embedSrc}, never taken from the input.
 */
export function parseEmbedUrl(raw: string | null | undefined): ParsedEmbed | null {
  const text = String(raw ?? '').trim();
  if (!text || text.length > 300) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') {
    return parts.length === 1 && YT_ID.test(parts[0]) ? { provider: 'YOUTUBE', id: parts[0] } : null;
  }
  if (YT_HOSTS.has(host)) {
    if (parts[0] === 'watch' && parts.length === 1) {
      const v = u.searchParams.get('v') ?? '';
      return YT_ID.test(v) ? { provider: 'YOUTUBE', id: v } : null;
    }
    if (['embed', 'shorts', 'live'].includes(parts[0]) && parts.length === 2) {
      return YT_ID.test(parts[1]) ? { provider: 'YOUTUBE', id: parts[1] } : null;
    }
    return null;
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    return parts.length === 1 && VIMEO_ID.test(parts[0]) ? { provider: 'VIMEO', id: parts[0] } : null;
  }
  if (host === 'player.vimeo.com') {
    return parts.length === 2 && parts[0] === 'video' && VIMEO_ID.test(parts[1])
      ? { provider: 'VIMEO', id: parts[1] }
      : null;
  }
  if (host === 'loom.com' || host === 'www.loom.com') {
    return parts.length === 2 && ['share', 'embed'].includes(parts[0]) && LOOM_ID.test(parts[1])
      ? { provider: 'LOOM', id: parts[1] }
      : null;
  }
  return null;
}

/** Builds the iframe src from a stored provider + id, re-validating the id. Null if invalid. */
export function embedSrc(provider: string | null | undefined, id: string | null | undefined): string | null {
  if (!id) return null;
  if (provider === 'YOUTUBE' && YT_ID.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if (provider === 'VIMEO' && VIMEO_ID.test(id)) return `https://player.vimeo.com/video/${id}`;
  if (provider === 'LOOM' && LOOM_ID.test(id)) return `https://www.loom.com/embed/${id}`;
  return null;
}

// ---- Blob URLs -----------------------------------------------------------------------------

const BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

/**
 * The exact public Blob host of OUR store, derived from BLOB_READ_WRITE_TOKEN
 * (`vercel_blob_rw_<storeId>_<secret>` -> `<storeid>.public.blob.vercel-storage.com`).
 *
 * Returns null when the token is absent or not in that shape. Callers FAIL CLOSED on null: no
 * uploaded-media URL is accepted, stored-for-render or deleted, rather than falling back to a
 * suffix match that would admit any Vercel Blob store.
 */
export function expectedBlobHost(token: string | undefined = process.env.BLOB_READ_WRITE_TOKEN): string | null {
  const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token ?? '');
  return m ? `${m[1].toLowerCase()}${BLOB_HOST_SUFFIX}` : null;
}

/** Path prefix every section upload for one practitioner lives under. */
export function uploadPrefix(practitionerId: string): string {
  return `sections/${practitionerId}/`;
}

const PATHNAME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;

/**
 * Validate a client-proposed upload pathname for the token route. It must be exactly
 * `sections/<practitionerId>/<video|image|poster>/<safe filename>`; returns the kind or null.
 */
export function parseUploadPathname(pathname: string, practitionerId: string): UploadKind | null {
  const prefix = uploadPrefix(practitionerId);
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split('/');
  if (rest.length !== 2) return null;
  const [kind, file] = rest;
  if (kind !== 'video' && kind !== 'image' && kind !== 'poster') return null;
  if (!PATHNAME_FILE.test(file)) return null;
  if (kind === 'video' ? !VIDEO_EXT.test(file) : !IMAGE_EXT.test(file)) return null;
  return kind;
}

/** Token-route policy for a validated upload kind. */
export function uploadPolicy(kind: UploadKind): { allowedContentTypes: string[]; maximumSizeInBytes: number } {
  return kind === 'video'
    ? { allowedContentTypes: [...VIDEO_CONTENT_TYPES], maximumSizeInBytes: maxVideoBytes() }
    : { allowedContentTypes: [...IMAGE_CONTENT_TYPES], maximumSizeInBytes: maxImageBytes() };
}

/**
 * Is this URL a Blob object that THIS practitioner uploaded for the given kind? https, a
 * `*.public.blob.vercel-storage.com` host exactly, no credentials/port/query/hash, and a decoded
 * path under `sections/<practitionerId>/<kind>/` with no traversal. Used before storing a url AND
 * before deleting one, so a client can never point a section (or a delete) at an arbitrary URL or
 * another practitioner's blob.
 */
export function isOwnedBlobUrl(
  raw: string | null | undefined,
  practitionerId: string,
  kind: UploadKind,
): boolean {
  if (!raw || raw.length > 600) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
  const expected = expectedBlobHost();
  if (!expected || u.hostname.toLowerCase() !== expected) return false;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname).replace(/^\//, '');
  } catch {
    return false;
  }
  if (path.includes('..') || path.includes('\\')) return false;
  return parseUploadPathname(path, practitionerId) === kind;
}

// ---- Normalising a submitted section -------------------------------------------------------

export type SectionInput = {
  title: unknown;
  bodyHtml: unknown;
  caption: unknown;
  mediaMode: unknown; // '' | 'embed' | 'video' | 'image'
  embedUrl: unknown;
  mediaUrl: unknown;
  posterUrl: unknown;
  published: boolean;
  attested: boolean;
};

export type SectionWrite = {
  title: string;
  bodyHtml: string | null;
  mediaKind: MediaKind | null;
  mediaUrl: string | null;
  embedProvider: EmbedProvider | null;
  embedId: string | null;
  posterUrl: string | null;
  caption: string | null;
  published: boolean;
};

export type SectionError =
  | 'title-required'
  | 'embed-invalid'
  | 'media-invalid'
  | 'poster-invalid'
  | 'media-unavailable'
  | 'attestation-required'
  | 'empty';

/**
 * Turn raw form input into the exact columns to write, or an error. Pure: the only identity it
 * needs is the practitioner id, to check uploaded URLs belong to them.
 */
export function buildSectionWrite(
  input: SectionInput,
  practitionerId: string,
): { ok: true; data: SectionWrite } | { ok: false; error: SectionError } {
  const title = cleanPlain(input.title, SECTION_TITLE_MAX);
  if (!title) return { ok: false, error: 'title-required' };

  const body = sanitizeSectionHtml(input.bodyHtml as string);
  const bodyHtml = isEmptyHtml(body) ? null : body;
  const caption = cleanPlain(input.caption, SECTION_CAPTION_MAX) || null;

  if (
    TESTIMONIAL_ATTESTATION_ENABLED &&
    mentionsTestimonial(title, bodyHtml, caption) &&
    !input.attested
  ) {
    return { ok: false, error: 'attestation-required' };
  }

  const mode = String(input.mediaMode ?? '');
  let media: Pick<SectionWrite, 'mediaKind' | 'mediaUrl' | 'embedProvider' | 'embedId' | 'posterUrl'> = {
    mediaKind: null,
    mediaUrl: null,
    embedProvider: null,
    embedId: null,
    posterUrl: null,
  };

  if (mode === 'embed') {
    const parsed = parseEmbedUrl(String(input.embedUrl ?? ''));
    if (!parsed) return { ok: false, error: 'embed-invalid' };
    media = { ...media, mediaKind: 'EMBED', embedProvider: parsed.provider, embedId: parsed.id };
  } else if (mode === 'video' || mode === 'image') {
    // Fail closed, with a distinct error, when our store host cannot be derived.
    if (!expectedBlobHost()) return { ok: false, error: 'media-unavailable' };
    const url = String(input.mediaUrl ?? '').trim();
    if (!isOwnedBlobUrl(url, practitionerId, mode)) return { ok: false, error: 'media-invalid' };
    media = { ...media, mediaKind: mode === 'video' ? 'VIDEO_UPLOAD' : 'IMAGE_UPLOAD', mediaUrl: url };
    if (mode === 'video') {
      const poster = String(input.posterUrl ?? '').trim();
      if (poster) {
        if (!isOwnedBlobUrl(poster, practitionerId, 'poster')) return { ok: false, error: 'poster-invalid' };
        media.posterUrl = poster;
      }
    }
  }

  if (!bodyHtml && !media.mediaKind) return { ok: false, error: 'empty' };

  return {
    ok: true,
    data: { title, bodyHtml, caption: media.mediaKind ? caption : null, ...media, published: input.published },
  };
}

/** Blob URLs a stored section owns (for deletion). */
export function ownedBlobUrls(
  section: { mediaKind: string | null; mediaUrl: string | null; posterUrl: string | null },
  practitionerId: string,
): string[] {
  const out: string[] = [];
  if (section.mediaKind === 'VIDEO_UPLOAD' && isOwnedBlobUrl(section.mediaUrl, practitionerId, 'video')) {
    out.push(section.mediaUrl as string);
  }
  if (section.mediaKind === 'IMAGE_UPLOAD' && isOwnedBlobUrl(section.mediaUrl, practitionerId, 'image')) {
    out.push(section.mediaUrl as string);
  }
  if (section.posterUrl && isOwnedBlobUrl(section.posterUrl, practitionerId, 'poster')) {
    out.push(section.posterUrl);
  }
  return out;
}

/** Validate a posted reorder: exactly the practitioner's own ids, each once. */
export function validateReorder(posted: unknown, ownIds: string[]): string[] | null {
  if (!Array.isArray(posted) || posted.some((v) => typeof v !== 'string')) return null;
  const ids = posted as string[];
  if (ids.length !== ownIds.length || new Set(ids).size !== ids.length) return null;
  const own = new Set(ownIds);
  return ids.every((id) => own.has(id)) ? ids : null;
}
