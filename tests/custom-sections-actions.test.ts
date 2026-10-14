import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  practitionerFind: vi.fn(),
  sectionFindFirst: vi.fn(),
  sectionFindMany: vi.fn(),
  sectionCount: vi.fn(),
  sectionCreate: vi.fn(),
  sectionUpdateMany: vi.fn(),
  sectionDeleteMany: vi.fn(),
  queryRaw: vi.fn(),
  del: vi.fn(),
  revalidatePath: vi.fn(),
  handleUpload: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/prisma', () => {
  const profileSection = {
    findFirst: mocks.sectionFindFirst,
    findMany: mocks.sectionFindMany,
    count: mocks.sectionCount,
    create: mocks.sectionCreate,
    updateMany: mocks.sectionUpdateMany,
    deleteMany: mocks.sectionDeleteMany,
  };
  const prisma = {
    practitioner: { findUnique: mocks.practitionerFind },
    profileSection,
    $queryRaw: mocks.queryRaw,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]),
  };
  return { prisma };
});
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@vercel/blob', () => ({ del: mocks.del }));
vi.mock('@vercel/blob/client', () => ({ handleUpload: mocks.handleUpload }));

import {
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
} from '@/app/practitioners/[slug]/edit/section-actions';
import { POST as tokenRoute } from '@/app/api/practitioners/[slug]/section-media/route';
import { CustomSections, type PublicSection } from '@/components/practitioners/CustomSections';

const OWNER = 'user_owner';
const PID = 'prac_mine';
const HOST = 'https://abc123.public.blob.vercel-storage.com';
const vid = `${HOST}/sections/${PID}/video/intro-x1.mp4`;
const poster = `${HOST}/sections/${PID}/poster/cover-x1.png`;
const img = `${HOST}/sections/${PID}/image/pic-x1.jpg`;

function fd(o: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
}
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    const m = (e as Error).message;
    if (m.startsWith('REDIRECT:')) return m.slice(9);
    throw e;
  }
  return null;
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.auth.mockResolvedValue({ user: { id: OWNER, role: 'PRACTITIONER' } });
  mocks.practitionerFind.mockResolvedValue({ id: PID, userId: OWNER });
  mocks.sectionFindMany.mockResolvedValue([]);
  mocks.sectionCount.mockResolvedValue(0);
  mocks.sectionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.del.mockResolvedValue(undefined);
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abc123_secret';
});

describe('ownership on every action', () => {
  const stranger = () => mocks.auth.mockResolvedValue({ user: { id: 'user_other', role: 'PRACTITIONER' } });
  const input = { title: 'T', bodyHtml: '<p>x</p>' };

  it.each([
    ['create', () => createSection('s', fd(input))],
    ['update', () => updateSection('s', fd({ ...input, sectionId: 'sec1' }))],
    ['delete', () => deleteSection('s', fd({ sectionId: 'sec1' }))],
    ['reorder', () => reorderSections('s', fd({ orderJson: '["sec1"]' }))],
  ])('%s: a non-owner is refused and nothing is written', async (_n, run) => {
    stranger();
    expect(await redirectOf(run())).toBe('/auth/error?error=AccessDenied');
    expect(mocks.sectionCreate).not.toHaveBeenCalled();
    expect(mocks.sectionUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sectionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('an unknown slug gets the same response as a foreign one (IDOR)', async () => {
    mocks.practitionerFind.mockResolvedValue(null);
    expect(await redirectOf(createSection('nope', fd(input)))).toBe('/auth/error?error=AccessDenied');
  });

  it('unauthenticated users are sent to sign-in', async () => {
    mocks.auth.mockResolvedValue(null);
    expect(await redirectOf(createSection('s', fd(input)))).toContain('/auth/signin');
  });

  it('a section id belonging to someone else is "not found" (queries are scoped by practitioner)', async () => {
    mocks.sectionFindFirst.mockResolvedValue(null);
    expect(await redirectOf(updateSection('s', fd({ ...input, sectionId: 'foreign' })))).toBe(
      '/practitioners/s/edit?error=section-not-found#sections',
    );
    expect(mocks.sectionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'foreign', practitionerId: PID } }),
    );
    expect(await redirectOf(deleteSection('s', fd({ sectionId: 'foreign' })))).toBe(
      '/practitioners/s/edit?error=section-not-found#sections',
    );
    expect(mocks.sectionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('an admin may edit another practitioner\'s sections', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'admin1', role: 'ADMIN' } });
    mocks.sectionFindMany.mockResolvedValue([]);
    await redirectOf(createSection('s', fd(input)));
    expect(mocks.sectionCreate).toHaveBeenCalled();
  });
});

describe('createSection', () => {
  it('creates with sanitized body, next sortOrder and the authorised practitioner id', async () => {
    mocks.sectionFindMany.mockResolvedValue([{ sortOrder: 4 }]);
    const to = await redirectOf(
      createSection('s', fd({ title: ' Hello ', bodyHtml: '<p onclick=x>a</p><script>1</script>', published: 'on', practitionerId: 'victim' })),
    );
    expect(to).toBe('/practitioners/s/edit#sections');
    const data = mocks.sectionCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ practitionerId: PID, title: 'Hello', bodyHtml: '<p>a</p>', sortOrder: 5, published: true });
  });

  it('enforces the cap server-side (default 6)', async () => {
    mocks.sectionFindMany.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ sortOrder: 5 - i })));
    expect(await redirectOf(createSection('s', fd({ title: 'T', bodyHtml: '<p>x</p>' })))).toBe(
      '/practitioners/s/edit?error=section-cap#sections',
    );
    expect(mocks.sectionCreate).not.toHaveBeenCalled();
  });

  it('the cap is env-configurable', async () => {
    process.env.PROFILE_SECTIONS_MAX = '2';
    try {
      mocks.sectionFindMany.mockResolvedValue([{ sortOrder: 1 }, { sortOrder: 0 }]);
      expect(await redirectOf(createSection('s', fd({ title: 'T', bodyHtml: '<p>x</p>' })))).toContain('section-cap');
    } finally {
      delete process.env.PROFILE_SECTIONS_MAX;
    }
  });

  it('rejects a media url pointing at another practitioner\'s blob or an arbitrary host', async () => {
    for (const mediaUrl of [vid.replace(PID, 'prac_victim'), 'https://evil.com/a.mp4']) {
      expect(await redirectOf(createSection('s', fd({ title: 'T', mediaMode: 'video', mediaUrl })))).toBe(
        '/practitioners/s/edit?error=section-media-invalid#sections',
      );
    }
    expect(mocks.sectionCreate).not.toHaveBeenCalled();
  });

  it('rejects a bad embed link and a missing title', async () => {
    expect(await redirectOf(createSection('s', fd({ title: 'T', mediaMode: 'embed', embedUrl: 'https://evil.com/x' })))).toContain('section-embed-invalid');
    expect(await redirectOf(createSection('s', fd({ title: '', bodyHtml: '<p>x</p>' })))).toContain('section-title-required');
  });
});

describe('blob deletion safety', () => {
  const stored = { id: 'sec1', mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: poster };

  it('deleting a section deletes its owned blobs with the pinned token', async () => {
    mocks.sectionFindFirst.mockResolvedValue(stored);
    await redirectOf(deleteSection('s', fd({ sectionId: 'sec1' })));
    expect(mocks.sectionDeleteMany).toHaveBeenCalledWith({ where: { id: 'sec1', practitionerId: PID } });
    expect(mocks.del).toHaveBeenCalledTimes(2);
    expect(mocks.del).toHaveBeenCalledWith(vid, { token: 'vercel_blob_rw_abc123_secret' });
    expect(mocks.del).toHaveBeenCalledWith(poster, { token: 'vercel_blob_rw_abc123_secret' });
  });

  it('never deletes a url that is not under this practitioner\'s upload prefix, even if stored', async () => {
    mocks.sectionFindFirst.mockResolvedValue({
      id: 'sec1',
      mediaKind: 'VIDEO_UPLOAD',
      mediaUrl: `${HOST}/sections/prac_victim/video/theirs.mp4`,
      posterUrl: 'https://evil.com/p.png',
    });
    await redirectOf(deleteSection('s', fd({ sectionId: 'sec1' })));
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('keeps a blob that another of the practitioner\'s sections still references', async () => {
    mocks.sectionFindFirst.mockResolvedValue({ id: 'sec1', mediaKind: 'IMAGE_UPLOAD', mediaUrl: img, posterUrl: null });
    mocks.sectionCount.mockResolvedValue(1);
    await redirectOf(deleteSection('s', fd({ sectionId: 'sec1' })));
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('a failing blob delete does not break the action', async () => {
    mocks.sectionFindFirst.mockResolvedValue(stored);
    mocks.del.mockRejectedValue(new Error('blob down'));
    expect(await redirectOf(deleteSection('s', fd({ sectionId: 'sec1' })))).toBe('/practitioners/s/edit#sections');
  });

  it('replacing media on update deletes the old blob only, and keeps the new one', async () => {
    mocks.sectionFindFirst.mockResolvedValue({ id: 'sec1', mediaKind: 'IMAGE_UPLOAD', mediaUrl: img, posterUrl: null });
    await redirectOf(
      updateSection('s', fd({ sectionId: 'sec1', title: 'T', mediaMode: 'video', mediaUrl: vid })),
    );
    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith(img, expect.any(Object));
  });

  it('a media url the client merely asserts is never deleted: update with same media deletes nothing', async () => {
    mocks.sectionFindFirst.mockResolvedValue({ id: 'sec1', mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: null });
    await redirectOf(updateSection('s', fd({ sectionId: 'sec1', title: 'T', mediaMode: 'video', mediaUrl: vid })));
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

describe('reorderSections', () => {
  beforeEach(() => {
    mocks.sectionFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });
  it('persists a permutation of own ids, scoped by practitioner', async () => {
    await reorderSections('s', fd({ orderJson: '["c","a","b"]' }));
    expect(mocks.sectionUpdateMany).toHaveBeenCalledTimes(3);
    expect(mocks.sectionUpdateMany).toHaveBeenCalledWith({ where: { id: 'c', practitionerId: PID }, data: { sortOrder: 0 } });
  });
  it.each(['["a","b","x"]', '["a","a","b"]', '["a","b"]', 'not json', '{"a":1}'])(
    'rejects %s',
    async (orderJson) => {
      expect(await redirectOf(reorderSections('s', fd({ orderJson })))).toBe(
        '/practitioners/s/edit?error=section-reorder-failed#sections',
      );
      expect(mocks.sectionUpdateMany).not.toHaveBeenCalled();
    },
  );
});

describe('upload token route', () => {
  const call = (slug = 's') =>
    tokenRoute(new Request('http://x/api', { method: 'POST', body: JSON.stringify({ type: 'blob.generate-client-token', payload: {} }) }), {
      params: { slug },
    });
  // The SDK is mocked: it just runs onBeforeGenerateToken for the pathname we choose.
  const withPath = (pathname: string) =>
    mocks.handleUpload.mockImplementation(async (o: { onBeforeGenerateToken: (p: string, c: string | null, m: boolean) => Promise<unknown>; token?: string }) => ({
      type: 'blob.generate-client-token',
      clientToken: JSON.stringify({ cfg: await o.onBeforeGenerateToken(pathname, null, false), token: o.token }),
    }));
  const cfgOf = async (res: Response) => JSON.parse((await res.json()).clientToken);

  it('issues a video token with type + 100MB limits, payload with the practitioner id, pinned token', async () => {
    withPath(`sections/${PID}/video/a.mp4`);
    const res = await call();
    expect(res.status).toBe(200);
    const { cfg, token } = await cfgOf(res);
    expect(cfg.allowedContentTypes).toEqual(['video/mp4', 'video/quicktime', 'video/webm']);
    expect(cfg.maximumSizeInBytes).toBe(100 * 1024 * 1024);
    expect(JSON.parse(cfg.tokenPayload)).toEqual({ practitionerId: PID, kind: 'video' });
    expect(token).toBe('vercel_blob_rw_abc123_secret');
  });
  it('issues an image token with 10MB limit', async () => {
    withPath(`sections/${PID}/image/a.png`);
    const { cfg } = await cfgOf(await call());
    expect(cfg.allowedContentTypes).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(cfg.maximumSizeInBytes).toBe(10 * 1024 * 1024);
  });
  it('size limits come from env', async () => {
    process.env.PROFILE_SECTION_VIDEO_MAX_MB = '50';
    try {
      withPath(`sections/${PID}/video/a.mp4`);
      const { cfg } = await cfgOf(await call());
      expect(cfg.maximumSizeInBytes).toBe(50 * 1024 * 1024);
    } finally {
      delete process.env.PROFILE_SECTION_VIDEO_MAX_MB;
    }
  });
  it('refuses a destination under another practitioner\'s prefix or outside sections/', async () => {
    for (const p of [`sections/prac_victim/video/a.mp4`, `photos/a.png`, `sections/${PID}/video/a.exe`, `sections/${PID}/../x/video/a.mp4`]) {
      withPath(p);
      expect((await call()).status).toBe(400);
    }
  });
  it('refuses non-owners, unknown slugs and anonymous callers with 400', async () => {
    withPath(`sections/${PID}/video/a.mp4`);
    mocks.auth.mockResolvedValue({ user: { id: 'user_other', role: 'PRACTITIONER' } });
    expect((await call()).status).toBe(400);
    mocks.auth.mockResolvedValue({ user: { id: OWNER, role: 'PRACTITIONER' } });
    mocks.practitionerFind.mockResolvedValue(null);
    expect((await call('nope')).status).toBe(400);
    mocks.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(400);
  });
});

describe('public render', () => {
  const sec = (o: Partial<PublicSection>): PublicSection => ({
    id: 'sec1',
    title: 'T',
    bodyHtml: null,
    mediaKind: null,
    mediaUrl: null,
    embedProvider: null,
    embedId: null,
    posterUrl: null,
    caption: null,
    published: true,
    ...o,
  });
  const html = (sections: PublicSection[]) =>
    renderToStaticMarkup(createElement(CustomSections, { sections, practitionerId: PID }));

  it('renders nothing for a profile without sections (profiles are unchanged)', () => {
    expect(html([])).toBe('');
  });
  it('never renders an unpublished section', () => {
    const out = html([sec({ title: 'Secret draft', bodyHtml: '<p>hidden</p>', published: false })]);
    expect(out).toBe('');
  });
  it('renders an uploaded MP4 with native controls, metadata preload and poster', () => {
    const out = html([sec({ mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: poster, caption: 'Intro' })]);
    expect(out).toContain('<video');
    expect(out).toContain('controls');
    expect(out).toContain('preload="metadata"');
    expect(out).toContain(`src="${vid}"`);
    expect(out).toContain(`poster="${poster}"`);
    expect(out).toContain('Intro');
  });
  it('renders an uploaded image', () => {
    const out = html([sec({ mediaKind: 'IMAGE_UPLOAD', mediaUrl: img, caption: 'Me' })]);
    expect(out).toContain('<img');
    expect(out).toContain(`src="${img}"`);
  });
  it('renders YouTube via youtube-nocookie, Vimeo and Loom iframes built from the id', () => {
    const yt = html([sec({ mediaKind: 'EMBED', embedProvider: 'YOUTUBE', embedId: 'dQw4w9WgXcQ' })]);
    expect(yt).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html([sec({ mediaKind: 'EMBED', embedProvider: 'VIMEO', embedId: '123456789' })])).toContain('https://player.vimeo.com/video/123456789');
    expect(html([sec({ mediaKind: 'EMBED', embedProvider: 'LOOM', embedId: 'a'.repeat(32) })])).toContain('https://www.loom.com/embed/' + 'a'.repeat(32));
  });
  it('does not render a poisoned embed id or a foreign/arbitrary media url', () => {
    expect(html([sec({ mediaKind: 'EMBED', embedProvider: 'YOUTUBE', embedId: '"><script>alert(1)</script>' })])).not.toContain('<iframe');
    expect(html([sec({ mediaKind: 'VIDEO_UPLOAD', mediaUrl: 'https://evil.com/a.mp4' })])).not.toContain('<video');
    expect(html([sec({ mediaKind: 'IMAGE_UPLOAD', mediaUrl: img.replace(PID, 'prac_victim') })])).not.toContain('<img');
    expect(html([sec({ mediaKind: 'VIDEO_UPLOAD', mediaUrl: vid, posterUrl: 'https://evil.com/p.png' })])).not.toContain('evil.com');
  });
  it('re-sanitizes stored HTML on render and escapes title and caption', () => {
    const out = html([
      sec({
        title: '<img src=x onerror=alert(1)>',
        caption: '<script>alert(2)</script>',
        bodyHtml: '<p>ok</p><script>alert(3)</script><a href="javascript:alert(4)">x</a>',
        mediaKind: 'IMAGE_UPLOAD',
        mediaUrl: img,
      }),
    ]);
    expect(out).toContain('<p>ok</p>');
    expect(out).not.toMatch(/<script|javascript:|<img src=x/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('keeps the provided order', () => {
    const out = html([sec({ id: 'a', title: 'First', bodyHtml: '<p>1</p>' }), sec({ id: 'b', title: 'Second', bodyHtml: '<p>2</p>' })]);
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });
});

describe('public page wiring', () => {
  it('queries only published sections in order and renders them between Outcomes and Reviews', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/app/practitioners/[slug]/page.tsx', 'utf8');
    expect(src).toContain("profileSections: { where: { published: true }, orderBy: { sortOrder: 'asc' } }");
    const outcomes = src.indexOf('aria-label="Outcomes"');
    const custom = src.indexOf('<CustomSections');
    const reviews = src.indexOf('aria-label="Reviews"');
    expect(outcomes).toBeGreaterThan(0);
    expect(custom).toBeGreaterThan(outcomes);
    expect(reviews).toBeGreaterThan(custom);
  });
});
