import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Check, CreditCard, Clock, AlertCircle, X } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { isWhopPlatformsReady } from '@/lib/whop';
import { profileCompletenessSignals } from '@/lib/practitioner-indexer';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { updatePractitioner } from './actions';

type Props = {
  params: { slug: string };
  searchParams: { welcome?: string; saved?: string; error?: string };
};

export const dynamic = 'force-dynamic';

export default async function EditPractitionerPage({ params, searchParams }: Props) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/auth/signin?callbackUrl=/practitioners/${params.slug}/edit`);
  }

  const practitioner = await prisma.practitioner.findUnique({
    where: { slug: params.slug },
    include: {
      specialties: { include: { specialty: true } },
      whopProducts: { where: { archived: false }, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!practitioner) notFound();

  const completeness = profileCompletenessSignals(practitioner);
  type MissingField = { key: keyof typeof completeness; label: string };
  const allFields: MissingField[] = [
    { key: 'hasDisplayName', label: 'Display name' },
    { key: 'hasCity', label: 'City' },
    { key: 'hasBio', label: 'Bio (20+ characters)' },
    { key: 'hasSpecialty', label: 'At least one specialty' },
  ];
  const missing = allFields.filter((f) => !completeness[f.key]);

  const isOwner = practitioner.userId === session.user.id;
  const isAdmin = session.user.role === 'ADMIN';
  if (!isOwner && !isAdmin) {
    redirect('/auth/error?error=AccessDenied');
  }

  const [cities, specialties] = await Promise.all([
    prisma.city.findMany({ orderBy: [{ state: 'asc' }, { name: 'asc' }] }),
    prisma.specialty.findMany({ orderBy: { name: 'asc' } }),
  ]);

  const selectedSpecialtyIds = new Set(
    practitioner.specialties.map((ps) => ps.specialtyId),
  );

  // Bind the slug for the form action
  const action = updatePractitioner.bind(null, params.slug);

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          href={`/practitioners/${params.slug}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to profile
        </Link>

        {searchParams.welcome && (
          <Card className="border-primary/30 bg-primary/5 p-4">
            <p className="text-sm">
              <strong>Welcome to HHE Directory.</strong> Fill in your profile below to make it
              public.
            </p>
          </Card>
        )}

        {missing.length > 0 && (
          <Card className="border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
                <AlertCircle className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden />
              </span>
              <div className="flex-1 space-y-2">
                <div>
                  <p className="text-sm font-semibold">Profile in progress</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Your profile is hidden from search + the landing page until these fields are
                    filled. Direct profile links still work.
                  </p>
                </div>
                <ul className="space-y-0.5 text-xs">
                  {missing.map((f) => (
                    <li key={f.key} className="flex items-center gap-1.5">
                      <X className="h-3 w-3 shrink-0 text-destructive" aria-hidden />
                      <span>{f.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Card>
        )}

        {missing.length === 0 && (
          <Card className="border-green-500/30 bg-green-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs">
              <Check className="h-3.5 w-3.5 text-green-600" />
              Profile complete — visible on /search and the landing page.
            </p>
          </Card>
        )}

        {searchParams.saved && (
          <Card className="border-green-500/30 bg-green-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs">
              <Check className="h-3.5 w-3.5 text-green-600" />
              Profile saved.{' '}
              <Link
                href={`/practitioners/${params.slug}`}
                className="font-medium underline underline-offset-2"
              >
                View public page
              </Link>
            </p>
          </Card>
        )}

        {searchParams.error === 'name-required' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">Display name is required.</p>
          </Card>
        )}
        {searchParams.error === 'invalid-booking-url' && (
          <Card className="border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs text-destructive">
              Booking URL doesn&apos;t look like a valid scheduling link. Use a full URL like
              <code className="mx-1 rounded bg-background px-1 py-0.5 text-foreground">
                https://cal.com/your-username
              </code>
              or a Calendly / SavvyCal / Acuity link.
            </p>
          </Card>
        )}

        <Card className="p-6 sm:p-8">
          <form action={action} className="space-y-5">
            <div className="space-y-1.5">
              <h1 className="text-xl font-semibold tracking-tight">Edit profile</h1>
              <p className="text-xs text-muted-foreground">
                Your slug: <code className="rounded bg-muted px-1.5 py-0.5">/{params.slug}</code>
              </p>
            </div>

            <Separator />

            <Field label="Display name" required>
              <input
                type="text"
                name="displayName"
                required
                defaultValue={practitioner.displayName}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Bio"
              hint="Short, plain-English description. What you do, who you work with, what makes you HHE-style."
            >
              <textarea
                name="bio"
                rows={5}
                defaultValue={practitioner.bio ?? ''}
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="City">
                <select
                  name="cityId"
                  defaultValue={practitioner.cityId ?? ''}
                  className="h-10 w-full rounded-md border bg-card px-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
                >
                  <option value="">— select a city —</option>
                  {cities.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}, {c.state}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Years in practice">
                <input
                  type="number"
                  name="yearsInPractice"
                  min={0}
                  max={70}
                  defaultValue={practitioner.yearsInPractice ?? ''}
                  className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
                />
              </Field>
            </div>

            <Field
              label="Booking link"
              hint="Your scheduling link (Cal.com, Calendly, SavvyCal, Acuity, etc.). Patients clicking 'Book intro consult' will land here. Leave empty if you're not taking new bookings."
            >
              <input
                type="url"
                name="bookingUrl"
                defaultValue={practitioner.bookingUrl ?? ''}
                placeholder="https://cal.com/your-username/intro-consult"
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Specialties"
              hint="Select all that apply. Parent + child specialties supported (e.g., Functional Medicine includes Hormone Balance)."
            >
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {specialties.map((s) => {
                  const checked = selectedSpecialtyIds.has(s.id);
                  return (
                    <li key={s.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm hover:bg-accent/40">
                        <input
                          type="checkbox"
                          name="specialtyIds"
                          value={s.id}
                          defaultChecked={checked}
                          className="h-4 w-4 rounded border-input"
                        />
                        <span>{s.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </Field>

            <Separator />

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              <Link
                href={`/practitioners/${params.slug}`}
                className="inline-flex h-10 items-center justify-center rounded-md border bg-card px-4 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </Link>
              <button
                type="submit"
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Save profile
              </button>
            </div>
          </form>
        </Card>

        <PaymentsSection
          kycStatus={practitioner.whopKycStatus}
          productCount={practitioner.whopProducts.length}
          platformsReady={isWhopPlatformsReady()}
        />

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {session.user.email}
          {isAdmin && ' · Admin'}
        </p>
      </div>
    </main>
  );
}

function PaymentsSection({
  kycStatus,
  productCount,
  platformsReady,
}: {
  kycStatus: 'NOT_STARTED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  productCount: number;
  platformsReady: boolean;
}) {
  return (
    <Card className="space-y-4 p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Payments</h2>
            <StatusBadge kycStatus={kycStatus} platformsReady={platformsReady} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Accept payments for sessions, packages, and memberships via Whop&apos;s multi-tenant
            payments platform.
          </p>
        </div>
      </div>

      <Separator />

      {!platformsReady && (
        <div className="space-y-2">
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Whop Platforms access is pending. HHE is applying for Whop&apos;s multi-tenant
              payments product (sub-merchant Connected Accounts). Once granted, you&apos;ll be able
              to set up your payout account, add offerings (intro consults, memberships,
              packages), and patients can pay directly.
            </span>
          </p>
          <button
            type="button"
            disabled
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border bg-muted/40 text-xs font-medium text-muted-foreground"
          >
            Connect with Whop · Coming soon
          </button>
          {productCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {productCount} offering{productCount === 1 ? '' : 's'} already configured (will go
              live once Whop verification completes).
            </p>
          )}
        </div>
      )}

      {platformsReady && kycStatus === 'NOT_STARTED' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Connect your payout account. Whop handles identity verification, tax forms, and
            payouts — you receive funds directly from each patient.
          </p>
          <button
            type="button"
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Connect with Whop
          </button>
        </div>
      )}

      {platformsReady && kycStatus === 'PENDING' && (
        <p className="text-xs text-muted-foreground">
          Whop is reviewing your account. This typically takes 1–2 business days. You&apos;ll get
          an email when verification completes.
        </p>
      )}

      {platformsReady && kycStatus === 'VERIFIED' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Your payout account is active. Add offerings below to start accepting payments.
          </p>
          <button
            type="button"
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Add an offering
          </button>
        </div>
      )}

      {platformsReady && kycStatus === 'REJECTED' && (
        <p className="text-xs text-destructive">
          Whop declined account verification. Contact HHE support.
        </p>
      )}
    </Card>
  );
}

function StatusBadge({
  kycStatus,
  platformsReady,
}: {
  kycStatus: string;
  platformsReady: boolean;
}) {
  if (!platformsReady) {
    return (
      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
        Pending access
      </Badge>
    );
  }
  if (kycStatus === 'NOT_STARTED') {
    return (
      <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
        Not connected
      </Badge>
    );
  }
  if (kycStatus === 'PENDING') {
    return (
      <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
        Verifying
      </Badge>
    );
  }
  if (kycStatus === 'VERIFIED') {
    return (
      <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
        <Check className="h-3 w-3" />
        Active
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
      Rejected
    </Badge>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
