import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { loadSettings, SETTING_DEFS } from '@/lib/platform-settings';

import { SettingForm } from './SettingForm';

export const dynamic = 'force-dynamic';

/**
 * The two operator-editable numbers that decide money (spec v1.4 §1.1, operator rulings 5 and 7
 * of 2026-09-18). They live on one screen because they are the same KIND of thing — commercial
 * terms the operator owns — and because the last time a term lived in three files it was three
 * different numbers.
 */
export default async function CommercialSettingsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/commercial-settings');
  }

  const settings = await loadSettings(prisma);

  // The held money this screen is accountable for. EXPIRED_UNCLAIMED is surfaced separately and
  // on purpose: day-91 policy is deliberately unruled, so the total is shown and NOTHING acts on
  // it — no forfeiture, no release. See the ReferralPayableState docs in schema.prisma.
  const [held, expired] = await Promise.all([
    prisma.referralLedgerEntry.aggregate({
      where: { state: 'HELD' },
      _sum: { referrerShareUsdCents: true },
      _count: true,
    }),
    prisma.referralLedgerEntry.aggregate({
      where: { state: 'EXPIRED_UNCLAIMED' },
      _sum: { referrerShareUsdCents: true },
      _count: true,
    }),
  ]);

  const dollars = (cents: number | null | undefined) =>
    `$${((cents ?? 0) / 100).toFixed(2)}`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>

      <h1 className="mt-4 text-2xl font-semibold text-slate-900">Commercial settings</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
        These two numbers decide what we charge and how long we hold a referrer’s share. Changes
        apply to <strong>new</strong> attributions and holds only — every existing row keeps the
        term and hold it was created under.
      </p>

      <div className="mt-6 space-y-4">
        <SettingForm
          name="leadAttributionTermMonths"
          label={SETTING_DEFS.leadAttributionTermMonths.label}
          help={SETTING_DEFS.leadAttributionTermMonths.help}
          unit="months"
          current={settings.leadAttributionTermMonths}
          min={SETTING_DEFS.leadAttributionTermMonths.min}
          max={SETTING_DEFS.leadAttributionTermMonths.max}
        />
        <SettingForm
          name="referralHoldDays"
          label={SETTING_DEFS.referralHoldDays.label}
          help={SETTING_DEFS.referralHoldDays.help}
          unit="days"
          current={settings.referralHoldDays}
          min={SETTING_DEFS.referralHoldDays.min}
          max={SETTING_DEFS.referralHoldDays.max}
        />
      </div>

      <section className="mt-10 rounded-lg border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Referral shares we are holding</h2>
        <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-slate-600">Held — referrer notified, within the hold period</dt>
            <dd className="mt-1 text-lg font-semibold text-slate-900">
              {dollars(held._sum.referrerShareUsdCents)}{' '}
              <span className="text-sm font-normal text-slate-600">({held._count} shares)</span>
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Expired unclaimed — hold ran out</dt>
            <dd className="mt-1 text-lg font-semibold text-slate-900">
              {dollars(expired._sum.referrerShareUsdCents)}{' '}
              <span className="text-sm font-normal text-slate-600">({expired._count} shares)</span>
            </dd>
          </div>
        </dl>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-600">
          Nothing happens to an expired share automatically. It is not forfeited to us and not
          released — the money stays owed and reconcilable until there is an explicit decision
          about what day 91 means. That decision is still open.
        </p>
      </section>
    </main>
  );
}
