import { embedSrc, isOwnedBlobUrl, sanitizeSectionHtml } from '@/lib/custom-sections';

export type PublicSection = {
  id: string;
  title: string;
  bodyHtml: string | null;
  mediaKind: string | null;
  mediaUrl: string | null;
  embedProvider: string | null;
  embedId: string | null;
  posterUrl: string | null;
  caption: string | null;
  published: boolean;
};

const BODY_CLASS =
  'text-sm leading-relaxed text-foreground [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mt-2 [&_h4]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5';

/**
 * Practitioner-authored sections on the public profile (L1b). Server component.
 *
 * Defence in depth: unpublished rows are dropped here even if the query already filtered them;
 * the text is re-sanitized on render; embeds are rebuilt from provider + id (never stored HTML);
 * and uploaded media must still validate as this practitioner's own Blob objects. Title and
 * caption are plain text rendered through React's escaping.
 */
export function CustomSections({
  sections,
  practitionerId,
}: {
  sections: PublicSection[];
  practitionerId: string;
}) {
  const visible = sections.filter((s) => s.published);
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((s) => {
        const body = s.bodyHtml ? sanitizeSectionHtml(s.bodyHtml) : '';
        return (
          <section
            key={s.id}
            aria-label={s.title}
            data-custom-section={s.id}
            className="space-y-3 rounded-xl bg-secondary/40 p-6"
          >
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {s.title}
            </h2>
            {body && <div className={BODY_CLASS} dangerouslySetInnerHTML={{ __html: body }} />}
            <SectionMedia s={s} practitionerId={practitionerId} />
          </section>
        );
      })}
    </>
  );
}

function SectionMedia({ s, practitionerId }: { s: PublicSection; practitionerId: string }) {
  let media: React.ReactNode = null;

  if (s.mediaKind === 'EMBED') {
    const src = embedSrc(s.embedProvider, s.embedId);
    if (src) {
      media = (
        <div className="aspect-video w-full overflow-hidden rounded-lg border bg-black">
          <iframe
            src={src}
            title={s.title}
            loading="lazy"
            className="h-full w-full"
            allow="fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          />
        </div>
      );
    }
  } else if (s.mediaKind === 'VIDEO_UPLOAD' && isOwnedBlobUrl(s.mediaUrl, practitionerId, 'video')) {
    const poster = isOwnedBlobUrl(s.posterUrl, practitionerId, 'poster') ? s.posterUrl : undefined;
    media = (
      <video
        controls
        preload="metadata"
        playsInline
        poster={poster ?? undefined}
        src={s.mediaUrl as string}
        className="w-full rounded-lg border bg-black"
      />
    );
  } else if (s.mediaKind === 'IMAGE_UPLOAD' && isOwnedBlobUrl(s.mediaUrl, practitionerId, 'image')) {
    media = (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={s.mediaUrl as string}
        alt={s.caption || s.title}
        loading="lazy"
        className="h-auto w-full rounded-lg border"
      />
    );
  }

  if (!media) return null;
  return (
    <figure className="space-y-1.5">
      {media}
      {s.caption && <figcaption className="text-xs text-muted-foreground">{s.caption}</figcaption>}
    </figure>
  );
}
