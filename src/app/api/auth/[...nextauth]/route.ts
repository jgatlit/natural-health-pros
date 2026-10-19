import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { withVerificationContext } from '@/lib/sign-in-recovery';

// GET still redeems links already sitting in inboxes; POST is what the /auth/confirm button sends.
export async function GET(req: NextRequest): Promise<Response> {
  return withVerificationContext(req, await handlers.GET(req));
}

export async function POST(req: NextRequest): Promise<Response> {
  return withVerificationContext(req, await handlers.POST(req));
}
