import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { parseUploadPathname, uploadPolicy } from '@/lib/custom-sections';

export const runtime = 'nodejs';

/**
 * Client-upload token route for custom profile section media (L1b), modelled on the photo route.
 *
 * The browser uploads straight to the PUBLIC photo store; this route only authorises it. It
 * confirms session + slug ownership (or admin), then pins everything the client could otherwise
 * choose: the destination must be exactly `sections/<this practitioner's id>/<video|image|poster>/
 * <safe filename>`, and the content types and size ceiling come from that kind, server-side. The
 * client-supplied clientPayload is ignored.
 *
 * "Not found" and "not yours" return the same error (IDOR discipline). The token is pinned
 * explicitly to BLOB_READ_WRITE_TOKEN; the private db-backup store is never referenced here.
 */
export async function POST(
  request: Request,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      request,
      body,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname) => {
        const session = await auth();
        if (!session?.user?.id) throw new Error('Not authenticated');
        const practitioner = await prisma.practitioner.findUnique({
          where: { slug: params.slug },
          select: { id: true, userId: true },
        });
        const isOwner = practitioner?.userId === session.user.id;
        const isAdmin = session.user.role === 'ADMIN';
        if (!practitioner || (!isOwner && !isAdmin)) {
          throw new Error('Not authorized to upload media for this profile');
        }
        const kind = parseUploadPathname(pathname, practitioner.id);
        if (!kind) throw new Error('Invalid upload destination');
        return {
          ...uploadPolicy(kind),
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ practitionerId: practitioner.id, kind }),
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload authorization failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
