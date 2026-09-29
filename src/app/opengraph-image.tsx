import { ImageResponse } from 'next/og';
import { getDirectory } from '@/lib/directory';
import { MARK_ON_DARK_PNG } from '@/lib/brand-mark-data';

/*
 * The social card. Rendered at request time from the brand tokens and the live
 * counts, so a shared link carries a real number rather than a stock photo.
 * Production has no OG image at all today — links render bare.
 */

export const runtime = 'nodejs';
// Same reason as the home page: the counts below are live directory state, and a
// card baked at build time would quote a number that has since moved.
export const dynamic = 'force-dynamic';
export const alt = 'Natural Health Pros — the natural health professional directory';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpengraphImage() {
  const { facts } = await getDirectory();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          background: 'linear-gradient(135deg, #1A2F4A 0%, #2C4A6E 100%)',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- next/og renders <img>; next/image is not available here */}
          <img src={MARK_ON_DARK_PNG} width={56} height={51} alt="" />
          <span style={{ fontSize: 30, letterSpacing: -0.5 }}>Natural Health Pros</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 68, lineHeight: 1.08, letterSpacing: -1.6, maxWidth: 940 }}>
            Natural Health Professional Directory
          </div>
          <div style={{ fontSize: 30, color: 'rgba(255,255,255,0.72)', maxWidth: 820 }}>
            Affordable, life-changing holistic health services at your fingertips
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 28, fontSize: 22 }}>
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>
            {facts.practitionerCount} trained practitioners
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
          <span style={{ color: 'rgba(255,255,255,0.6)' }}>
            {facts.specialtyCount} specialties
          </span>
          <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
          <span style={{ color: '#F2D0DE' }}>naturalhealthpros.com</span>
        </div>
      </div>
    ),
    size,
  );
}
