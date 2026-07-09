import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

/**
 * Client-upload token route for practitioner profile photos.
 *
 * The edit form uploads the image straight to Vercel Blob from the browser
 * (avoids the 4.5MB server-action body cap). This route only authorizes the
 * upload: it confirms the signed-in user owns the slug (or is an admin), then
 * hands back a short-lived client token scoped to image content types.
 *
 * Requires BLOB_READ_WRITE_TOKEN in the environment (read implicitly by
 * handleUpload). The actual photoUrl persistence happens in the edit form's
 * server action — the returned blob URL is written into a hidden field.
 */
export async function POST(
  request: Request,
  { params }: { params: { slug: string } },
): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => {
        const session = await auth();
        if (!session?.user?.id) {
          throw new Error('Not authenticated');
        }
        const practitioner = await prisma.practitioner.findUnique({
          where: { slug: params.slug },
          select: { userId: true },
        });
        // Merge "not found" + "unauthorized" into one response (IDOR discipline).
        const isOwner = practitioner?.userId === session.user.id;
        const isAdmin = session.user.role === 'ADMIN';
        if (!practitioner || (!isOwner && !isAdmin)) {
          throw new Error('Not authorized to upload a photo for this profile');
        }
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
          maximumSizeInBytes: 8 * 1024 * 1024, // 8MB — headshots are small
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ slug: params.slug }),
        };
      },
      // No onUploadCompleted: the blob URL round-trips through the form and the
      // server action persists it. (onUploadCompleted requires a public callback
      // URL and doesn't fire on localhost, so we don't depend on it.)
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload authorization failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
