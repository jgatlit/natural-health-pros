import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { loadSettings, SETTING_DEFS } from '@/lib/platform-settings';
import { planComparison } from '@/lib/pricing-plans';
import { getCurrentSchedule } from '@/lib/rate-schedules';
import { scheduleNumbers } from '@/lib/rate-schedule';

import { AssignUnassignedForm, MigrateCohortForm, RateScheduleForm } from './RateScheduleForm';
import { SettingForm } from './SettingForm';
import { AffiliateLedgerSection } from './AffiliateLedgerSection';
import { TransfersNeedingAttention } from './TransfersNeedingAttention';

export const dynamic = 'force-dynamic';

/**
 * The operator-editable numbers that decide money. The rate schedule (rates, referral split,
 * affiliate share and both attribution terms — spec v1.5 §2) and the referral hold period (spec
 * v1.4 §1.1, ruling 7) live on one screen because they are the same KIND of thing — commercial
 * terms the operator owns — and because the last time a term lived in three files it was three
 * different numbers.
 */
export default async function CommercialSettingsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/commercial-settings');
  }

  const settings = await loadSettings(prisma);
  const current = await getCurrentSchedule(prisma);

  // Members per schedule: every stored schedule, with how many practitioners are on it.
  const [allSchedules, memberGroups, noSchedule] = await Promise.all([
    prisma.rateSchedule.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, label: true } }),
    prisma.practitioner.groupBy({ by: ['rateScheduleId'], _count: { _all: true } }),
    prisma.practitioner.count({ where: { rateScheduleId: null } }),
  ]);
  const memberCount = new Map(memberGroups.map((g) => [g.rateScheduleId, g._count._all]));
  const schedulesWithMembers = allSchedules.map((sc) => ({
    ...sc,
    members: memberCount.get(sc.id) ?? 0,
  }));

  // The held money this screen is accountable for. EXPIRED_UNCLAIMED is surfaced separately and
  // on purpose: day-91 policy is deliberately unruled, so the total is shown and NOTHING acts on
  // it — no forfeiture, no release. See the ReferralPayableState docs in schema.prisma.
  const [held, expired, changes] = await Promise.all([
    prisma.referralLedgerEntry.aggregate({
      where: { state: 'HELD' },
      _sum: { referrerShareUsdCents: true, reversedUsdCents: true },
      _count: true,
    }),
    prisma.referralLedgerEntry.aggregate({
      where: { state: 'EXPIRED_UNCLAIMED' },
      _sum: { referrerShareUsdCents: true, reversedUsdCents: true },
      _count: true,
    }),
    // Spec §1.1: "Every change is logged with the admin, the time, and the old and new values."
    // Surfaced HERE rather than in a separate screen, because the question it answers — "why is
    // the term 6 months now?" — only ever gets asked while looking at the number.
    prisma.platformSettingChange.findMany({
      orderBy: { changedAt: 'desc' },
      take: 20,
    }),
  ]);

  const dollars = (cents: number | null | undefined) =>
    `$${((cents ?? 0) / 100).toFixed(2)}`;
  // What is still owed: the share less refunds.
  const owed = (sum: { referrerShareUsdCents: number | null; reversedUsdCents: number | null }) =>
    (sum.referrerShareUsdCents ?? 0) - (sum.reversedUsdCents ?? 0);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>

      <h1 className="mt-4 text-2xl font-semibold text-slate-900">Commercial settings</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
        A rate change creates a new schedule for <strong>new sign-ups</strong>; existing
        practitioners keep theirs until you migrate them, and every attributed client and held
        share keeps the term and rates it was created under.
      </p>

      {!current ? (
        <section className="mt-6 rounded-lg border border-red-300 bg-red-50 p-5 text-sm text-red-800">
          <strong>No current rate schedule is configured.</strong> New sign-ups cannot be created and
          checkout refuses practitioners without a schedule. Save one below, then assign it to anyone who has none.
        </section>
      ) : (
        <PlanTermsInForce schedule={current} />
      )}

      {noSchedule > 0 && current && (
        <div className="mt-4">
          <AssignUnassignedForm count={noSchedule} />
        </div>
      )}
      {noSchedule > 0 && !current && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {noSchedule} practitioner{noSchedule === 1 ? ' has' : 's have'} no rate schedule. Save a current
          schedule below first, then assign it to them here.
        </p>
      )}

      <div className="mt-6 space-y-4">
        {current && (
          <RateScheduleForm initial={scheduleNumbers(current)} currentLabel={current.label ?? current.id} />
        )}

        <section className="rounded-lg border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-900">Practitioners per schedule</h2>
          <table className="mt-3 w-full text-sm">
            <tbody className="text-slate-700">
              {schedulesWithMembers.map((sc) => (
                <tr key={sc.id} className="border-t border-slate-100">
                  <td className="py-1.5">
                    {sc.label}
                    {current?.id === sc.id && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs">current for sign-ups</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right">{sc.members}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <MigrateCohortForm schedules={schedulesWithMembers} />

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
              {dollars(owed(held._sum))}{' '}
              <span className="text-sm font-normal text-slate-600">({held._count} shares)</span>
            </dd>
          </div>
          <div>
            <dt className="text-slate-600">Expired unclaimed — hold ran out</dt>
            <dd className="mt-1 text-lg font-semibold text-slate-900">
              {dollars(owed(expired._sum))}{' '}
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

      <TransfersNeedingAttention />

      <AffiliateLedgerSection />

      <section className="mt-6 rounded-lg border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-900">Change history</h2>
        <p className="mt-1 text-sm text-slate-600">
          Who changed what, when, and from what value. Existing attributions and holds keep the
          numbers they were created under, so a change here is never retroactive.
        </p>
        {changes.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing has been changed yet.</p>
        ) : (
          <ul className="mt-3 space-y-1 text-sm text-slate-700">
            {changes.map((c) => (
              <li key={c.id} className="font-mono text-xs">
                {c.changedAt.toISOString().slice(0, 16).replace('T', ' ')} · {c.key} ·{' '}
                {c.oldValue ?? '(unset)'} → {c.newValue} · {c.changedByUserId ?? 'unknown admin'}
                {c.reason ? ` · reason: ${c.reason}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/** Read-only summary of what a practitioner on the current schedule is shown and charged. */
function PlanTermsInForce({ schedule }: { schedule: NonNullable<Awaited<ReturnType<typeof getCurrentSchedule>>> }) {
  const { cards, breakEvenMonthlyLabel, referral } = planComparison(schedule);
  return (
    <section className="mt-6 rounded-lg border border-slate-200 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Current schedule: {schedule.label}</h2>
        <p className="text-xs text-slate-500">Read-only summary of the saved schedule.</p>
      </div>
      <table className="mt-3 w-full text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="py-1 font-normal" scope="col"><span className="sr-only">Term</span></th>
            {cards.map((c) => (
              <th key={c.key} className="py-1 font-medium text-slate-900" scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-slate-700">
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">Monthly</th>
            {cards.map((c) => (<td key={c.key} className="py-1.5">{c.monthlyLabel}</td>))}
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">Yearly (derived)</th>
            {cards.map((c) => (<td key={c.key} className="py-1.5">{c.annualLabel ?? '—'}</td>))}
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">
              Share on clients we send, first {referral.termMonths} months
            </th>
            {cards.map((c) => (<td key={c.key} className="py-1.5">{c.sourcedSessionLabel}</td>))}
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">After the term</th>
            {cards.map((c) => (<td key={c.key} className="py-1.5">{c.afterTermLabel}</td>))}
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">Referred client</th>
            <td className="py-1.5" colSpan={cards.length}>
              {referral.referralTotalLabel} for the first {referral.referrerTermMonths} months on either plan:{' '}
              {referral.referrerRateLabel} to the referrer, {referral.nhpReferralRateLabel} to us; then the plan rate
            </td>
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">Break-even</th>
            <td className="py-1.5" colSpan={cards.length}>
              {cards[0]?.label} is cheaper above about {breakEvenMonthlyLabel} a month of clients we send
            </td>
          </tr>
          <tr className="border-t border-slate-100">
            <th className="py-1.5 text-left font-normal text-slate-500" scope="row">Own or invited clients</th>
            <td className="py-1.5" colSpan={cards.length}>0%, on either plan, with no end date</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
