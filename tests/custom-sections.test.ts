import { describe, it, expect } from 'vitest';
import {
  buildSectionWrite,
  embedSrc,
  isOwnedBlobUrl,
  maxSections,
  ownedBlobUrls,
  parseEmbedUrl,
  parseUploadPathname,
  sanitizeSectionHtml,
  uploadPolicy,
  validateReorder,
  TESTIMONIAL_ATTESTATION_ENABLED,
} from '@/lib/custom-sections';

const PID = 'prac_abc123';
const HOST = 'https://abc123.public.blob.vercel-storage.com';
const vid = `${HOST}/sections/${PID}/video/intro-x1.mp4`;
const img = `${HOST}/sections/${PID}/image/pic-x1.png`;
const poster = `${HOST}/sections/${PID}/poster/cover-x1.webp`;

describe('sanitizeSectionHtml', () => {
  const clean = (s: string | null | undefined) => sanitizeSectionHtml(s);

  it('removes script tags AND their contents', () => {
    expect(clean('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>');
  });
  it('removes inline style and class/id', () => {
    const out = clean('<p style="color:red" class="x" id="y">hi</p>');
    expect(out).toBe('<p>hi</p>');
  });
  it('drops javascript: links but keeps the text', () => {
    const out = clean('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript/i);
    expect(out).toContain('click');
    expect(out).not.toContain('href');
  });
  it('drops obfuscated javascript: schemes', () => {
    for (const href of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', '&#106;avascript:alert(1)', ' javascript:alert(1)']) {
      expect(clean(`<a href="${href}">x</a>`)).not.toMatch(/href/);
    }
  });
  it('drops data:, vbscript:, http: and protocol-relative links (https only)', () => {
    for (const href of ['data:text/html,<script>alert(1)</script>', 'vbscript:x', 'http://example.com', '//example.com', 'mailto:a@b.co', 'ftp://x.y']) {
      expect(clean(`<a href="${href}">x</a>`)).not.toMatch(/href/);
    }
  });
  it('keeps https links and forces rel/target', () => {
    const out = clean('<a href="https://example.com/a?b=1" target="_self" rel="opener">x</a>');
    expect(out).toBe('<a href="https://example.com/a?b=1" rel="nofollow noopener" target="_blank">x</a>');
  });
  it('strips event handler attributes', () => {
    expect(clean('<p onclick="x()" onmouseover="y()">a</p><strong onerror="z()">b</strong>')).toBe('<p>a</p><strong>b</strong>');
  });
  it('removes img, iframe, object, embed, svg, form, input, style, link, meta, base', () => {
    const out = clean(
      '<img src=x onerror=alert(1)><iframe src="https://evil.com"></iframe><object data=x></object><embed src=x><svg onload=alert(1)><circle/></svg><form action=x><input name=a></form><style>p{}</style><link rel=stylesheet href=x><meta http-equiv=refresh><base href="https://evil.com">ok',
    );
    expect(out).toBe('ok');
  });
  it('defeats nested / mXSS-style payloads', () => {
    const payloads = [
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<<script>script>alert(1)<</script>/script>',
      '<p><svg><style><img src=x onerror=alert(1)></style></svg></p>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<textarea><script>alert(1)</script></textarea>',
      '<a href="https://ok.com" onclick="alert(1)"><img src=x onerror=alert(1)></a>',
      '<p title="x" <script>alert(1)</script>>t</p>',
    ];
    for (const p of payloads) {
      const out = clean(p);
      expect(out).not.toMatch(/<script|<img|<svg|<style|<iframe|onerror|onclick|onload|<math|<textarea|<noscript/i);
      // Output must be a fixpoint: re-sanitizing on render changes nothing.
      expect(clean(out)).toBe(out);
    }
  });
  it('is idempotent on allowed content', () => {
    const html = '<h3>T</h3><p>a <em>b</em> <u>c</u><br></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><h4>s</h4><a href="https://e.co">l</a>';
    const once = clean(html);
    expect(clean(once)).toBe(once);
    expect(once).toContain('<h3>T</h3>');
  });
  it('handles null/undefined', () => {
    expect(clean(null)).toBe('');
    expect(clean(undefined)).toBe('');
  });
});

describe('parseEmbedUrl', () => {
  it('parses YouTube forms', () => {
    const id = 'dQw4w9WgXcQ';
    for (const u of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=10`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `https://www.youtube.com/shorts/${id}`,
    ]) {
      expect(parseEmbedUrl(u)).toEqual({ provider: 'YOUTUBE', id });
    }
  });
  it('parses Vimeo and Loom', () => {
    expect(parseEmbedUrl('https://vimeo.com/123456789')).toEqual({ provider: 'VIMEO', id: '123456789' });
    expect(parseEmbedUrl('https://player.vimeo.com/video/123456789')).toEqual({ provider: 'VIMEO', id: '123456789' });
    const loom = 'a'.repeat(16) + '0123456789abcdef';
    expect(parseEmbedUrl(`https://www.loom.com/share/${loom}`)).toEqual({ provider: 'LOOM', id: loom });
    expect(parseEmbedUrl(`https://www.loom.com/embed/${loom}?hide_owner=true`)).toEqual({ provider: 'LOOM', id: loom });
  });
  it('rejects lookalike hosts, credentials, ports and non-https', () => {
    const id = 'dQw4w9WgXcQ';
    for (const u of [
      `https://youtube.com.evil.com/watch?v=${id}`,
      `https://evilyoutube.com/watch?v=${id}`,
      `https://evil.com/youtube.com/watch?v=${id}`,
      `https://youtube.com@evil.com/watch?v=${id}`,
      `https://www.youtube.com:8443/watch?v=${id}`,
      `http://www.youtube.com/watch?v=${id}`,
      `javascript:alert(1)//youtube.com/watch?v=${id}`,
      'https://vimeo.com.evil.com/123456789',
      'https://notloom.com/share/' + 'a'.repeat(32),
      'https://player.loom.com/embed/' + 'a'.repeat(32),
    ]) {
      expect(parseEmbedUrl(u)).toBeNull();
    }
  });
  it('rejects injected ids', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=abc"onload="x',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ%22%3E',
      'https://vimeo.com/12ab',
      'https://vimeo.com/123456789/extra',
      'https://www.loom.com/share/ZZZ',
      'https://www.loom.com/share/' + 'a'.repeat(31) + '"',
      'https://www.youtube.com/playlist?list=abc',
      '',
      'not a url',
    ]) {
      expect(parseEmbedUrl(u)).toBeNull();
    }
  });
});

describe('embedSrc', () => {
  it('builds trusted URLs from provider + id only', () => {
    expect(embedSrc('YOUTUBE', 'dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(embedSrc('VIMEO', '123456789')).toBe('https://player.vimeo.com/video/123456789');
    expect(embedSrc('LOOM', 'a'.repeat(32))).toBe('https://www.loom.com/embed/' + 'a'.repeat(32));
  });
  it('refuses unknown providers and malformed stored ids', () => {
    expect(embedSrc('EVIL', 'dQw4w9WgXcQ')).toBeNull();
    expect(embedSrc('YOUTUBE', '"><script>')).toBeNull();
    expect(embedSrc('YOUTUBE', null)).toBeNull();
  });
});

describe('blob URL ownership', () => {
  it('accepts own urls of the matching kind', () => {
    expect(isOwnedBlobUrl(vid, PID, 'video')).toBe(true);
    expect(isOwnedBlobUrl(img, PID, 'image')).toBe(true);
    expect(isOwnedBlobUrl(poster, PID, 'poster')).toBe(true);
  });
  it('rejects another practitioner, wrong kind, wrong host and traversal', () => {
    expect(isOwnedBlobUrl(vid, 'someone_else', 'video')).toBe(false);
    expect(isOwnedBlobUrl(vid, PID, 'image')).toBe(false);
    expect(isOwnedBlobUrl(`${HOST}/sections/other/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`https://evil.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`https://abc.public.blob.vercel-storage.com.evil.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`https://x.y.public.blob.vercel-storage.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`${HOST}/sections/${PID}/video/..%2F..%2Fother/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`${HOST}/sections/${PID}/video/a.mp4?x=1`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`http://abc123.public.blob.vercel-storage.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`https://u:p@abc123.public.blob.vercel-storage.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`${HOST}/photos/${PID}.jpg`, PID, 'image')).toBe(false);
    expect(isOwnedBlobUrl(`${HOST}/sections/${PID}/video/a.exe`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl('javascript:alert(1)', PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(null, PID, 'video')).toBe(false);
  });
  it('rejects the private backup store naming and the bare suffix host', () => {
    expect(isOwnedBlobUrl(`https://abc123.private.blob.vercel-storage.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
    expect(isOwnedBlobUrl(`https://public.blob.vercel-storage.com/sections/${PID}/video/a.mp4`, PID, 'video')).toBe(false);
  });
});

describe('upload pathname + policy', () => {
  it('only accepts sections/<own id>/<kind>/<safe file>', () => {
    expect(parseUploadPathname(`sections/${PID}/video/a.mp4`, PID)).toBe('video');
    expect(parseUploadPathname(`sections/${PID}/image/a.JPG`, PID)).toBe('image');
    expect(parseUploadPathname(`sections/${PID}/poster/a.webp`, PID)).toBe('poster');
    expect(parseUploadPathname(`sections/other/video/a.mp4`, PID)).toBeNull();
    expect(parseUploadPathname(`photos/a.png`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/video/a.png`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/image/a.mp4`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/video/../../x.mp4`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/video/sub/a.mp4`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/other/a.mp4`, PID)).toBeNull();
    expect(parseUploadPathname(`sections/${PID}/video/.mp4`, PID)).toBeNull();
  });
  it('video and image policies use the specified types and defaults', () => {
    const v = uploadPolicy('video');
    expect(v.allowedContentTypes).toEqual(['video/mp4', 'video/quicktime', 'video/webm']);
    expect(v.maximumSizeInBytes).toBe(100 * 1024 * 1024);
    for (const k of ['image', 'poster'] as const) {
      const p = uploadPolicy(k);
      expect(p.allowedContentTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
      expect(p.maximumSizeInBytes).toBe(10 * 1024 * 1024);
    }
  });
});

describe('config defaults', () => {
  it('caps at 6 and ships the testimonial attestation OFF', () => {
    expect(maxSections()).toBe(6);
    expect(TESTIMONIAL_ATTESTATION_ENABLED).toBe(false);
  });
});

describe('buildSectionWrite', () => {
  const base = {
    title: 'My approach',
    bodyHtml: '<p>hello</p>',
    caption: '',
    mediaMode: '',
    embedUrl: '',
    mediaUrl: '',
    posterUrl: '',
    published: true,
    attested: false,
  };
  it('requires a name and caps it at 80 chars', () => {
    expect(buildSectionWrite({ ...base, title: '   ' }, PID)).toEqual({ ok: false, error: 'title-required' });
    const r = buildSectionWrite({ ...base, title: 'x'.repeat(200) }, PID);
    expect(r.ok && r.data.title.length).toBe(80);
  });
  it('title and caption are plain text (control chars stripped; markup kept as literal text for React to escape)', () => {
    const r = buildSectionWrite({ ...base, title: '<img src=x onerror=alert(1)>\u0000a', caption: '<b>c</b>', mediaMode: 'embed', embedUrl: 'https://youtu.be/dQw4w9WgXcQ' }, PID);
    expect(r.ok && r.data.title).toBe('<img src=x onerror=alert(1)> a');
    expect(r.ok && r.data.caption).toBe('<b>c</b>');
  });
  it('sanitizes the body on save', () => {
    const r = buildSectionWrite({ ...base, bodyHtml: '<p style="x">a</p><script>x</script><a href="javascript:1">b</a>' }, PID);
    expect(r.ok && r.data.bodyHtml).toBe('<p>a</p>b');
  });
  it('a body that sanitizes to nothing with no media is rejected', () => {
    expect(buildSectionWrite({ ...base, bodyHtml: '<script>x</script>' }, PID)).toEqual({ ok: false, error: 'empty' });
  });
  it('builds EMBED from the parsed id, never from raw input', () => {
    const r = buildSectionWrite({ ...base, mediaMode: 'embed', embedUrl: 'https://youtu.be/dQw4w9WgXcQ', mediaUrl: vid }, PID);
    expect(r.ok && r.data).toMatchObject({ mediaKind: 'EMBED', embedProvider: 'YOUTUBE', embedId: 'dQw4w9WgXcQ', mediaUrl: null });
    expect(buildSectionWrite({ ...base, mediaMode: 'embed', embedUrl: 'https://evil.com/x' }, PID)).toEqual({ ok: false, error: 'embed-invalid' });
  });
  it('accepts own uploads and rejects foreign / arbitrary urls', () => {
    expect(buildSectionWrite({ ...base, mediaMode: 'video', mediaUrl: vid, posterUrl: poster }, PID)).toMatchObject({
      ok: true,
      data: { mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: poster },
    });
    expect(buildSectionWrite({ ...base, mediaMode: 'image', mediaUrl: img }, PID)).toMatchObject({ ok: true, data: { mediaKind: 'IMAGE_UPLOAD' } });
    expect(buildSectionWrite({ ...base, mediaMode: 'video', mediaUrl: 'https://evil.com/a.mp4' }, PID)).toEqual({ ok: false, error: 'media-invalid' });
    expect(buildSectionWrite({ ...base, mediaMode: 'video', mediaUrl: vid.replace(PID, 'victim') }, PID)).toEqual({ ok: false, error: 'media-invalid' });
    expect(buildSectionWrite({ ...base, mediaMode: 'video', mediaUrl: vid, posterUrl: 'https://evil.com/p.png' }, PID)).toEqual({ ok: false, error: 'poster-invalid' });
    expect(buildSectionWrite({ ...base, mediaMode: 'image', mediaUrl: vid }, PID)).toEqual({ ok: false, error: 'media-invalid' });
  });
  it('ignores a poster for non-video media', () => {
    const r = buildSectionWrite({ ...base, mediaMode: 'image', mediaUrl: img, posterUrl: poster }, PID);
    expect(r.ok && r.data.posterUrl).toBeNull();
  });
});

describe('ownedBlobUrls', () => {
  it('lists only urls that validate as this practitioner\'s', () => {
    expect(ownedBlobUrls({ mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: poster }, PID)).toEqual([vid, poster]);
    expect(ownedBlobUrls({ mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid.replace(PID, 'victim'), posterUrl: null }, PID)).toEqual([]);
    expect(ownedBlobUrls({ mediaKind: 'EMBED', mediaUrl: vid, posterUrl: null }, PID)).toEqual([]);
    expect(ownedBlobUrls({ mediaKind: 'IMAGE_UPLOAD', mediaUrl: 'https://evil.com/x.png', posterUrl: null }, PID)).toEqual([]);
  });
});

describe('validateReorder', () => {
  const own = ['a', 'b', 'c'];
  it('accepts a permutation of exactly the own ids', () => {
    expect(validateReorder(['c', 'a', 'b'], own)).toEqual(['c', 'a', 'b']);
  });
  it('rejects foreign ids, duplicates, missing/extra ids and junk', () => {
    expect(validateReorder(['a', 'b', 'x'], own)).toBeNull();
    expect(validateReorder(['a', 'a', 'b'], own)).toBeNull();
    expect(validateReorder(['a', 'b'], own)).toBeNull();
    expect(validateReorder(['a', 'b', 'c', 'd'], own)).toBeNull();
    expect(validateReorder('a,b,c', own)).toBeNull();
    expect(validateReorder([1, 2, 3], own)).toBeNull();
    expect(validateReorder(null, own)).toBeNull();
  });
});
