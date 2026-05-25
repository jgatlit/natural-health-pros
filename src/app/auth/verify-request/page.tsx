import { Mail } from 'lucide-react';
import { Card } from '@/components/ui/card';

export default function VerifyRequest() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Mail className="h-5 w-5 text-muted-foreground" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Check your inbox</h1>
            <p className="text-sm text-muted-foreground">
              We sent you a sign-in link. Click it to continue.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            The link expires in 24 hours. If you don&apos;t see the email, check spam.
          </p>
        </Card>
      </div>
    </main>
  );
}
