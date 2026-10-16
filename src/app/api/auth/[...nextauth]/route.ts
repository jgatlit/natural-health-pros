import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { withVerificationContext } from '@/lib/sign-in-recovery';

export const { POST } = handlers;

export async function GET(req: NextRequest): Promise<Response> {
  return withVerificationContext(req, await handlers.GET(req));
}
