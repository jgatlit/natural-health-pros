import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpecialtyComboboxField } from '@/components/practitioners/SpecialtyComboboxField';
import { OnboardingSubmitButton } from '@/components/practitioners/OnboardingSubmitButton';
import { CityField } from '@/components/practitioners/CityField';
import { TermsAcknowledgment } from '@/components/practitioners/TermsAcknowledgment';
import { PlanTermsSummary } from '@/components/practitioners/PlanTermsSummary';
import type { PlanCardView } from '@/components/practitioners/PlanChoice';
import type { DisplaySettings } from '@/lib/platform-settings';
import { OUTSIDE_WORK_FIELD, OUTSIDE_WORK_HELPER, OUTSIDE_WORK_QUESTION } from '@/lib/outside-work';
import type { ReferralTermsView } from '@/lib/pricing-plans';

const SPECIALTY_REQUIRED_HINT =
  'Add at least one specialty, in your own words, so clients can find you in search.';

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  isPrefilled: boolean;
  llmConfigured: boolean;
  values: {
    displayName: string;
    describe: string;
    cityName: string;
    cityState: string;
    yearsInPractice: number | null;
    telehealth: boolean;
    inPerson: boolean;
    /** null = never answered: neither radio is checked. */
    openToOutsideWork: boolean | null;
  };
  specialties: { id: string; name: string }[];
  aliases: { label: string; specialtyId: string }[];
  initialSpecialties: { specialtyId: string; rawLabel: string }[];
  termsAcceptedAt: Date | null;
  planTerms: { plans: PlanCardView[]; referral: ReferralTermsView; display: DisplaySettings };
  /** Spec §5: shown before plan choice, only when a recruiter was captured. */
  recruiterDisclosure?: string | null;
};

/**
 * First-run onboarding form. Collects the basics + a free-text description; on
 * submit the server action (submitOnboarding) one-shot generates the landing page.
 * Ongoing field-level editing (and offerings + booking links) live in the admin
 * portal afterward.
 */
export function OnboardingForm({
  action,
  isPrefilled,
  llmConfigured,
  values,
  specialties,
  aliases,
  initialSpecialties,
  termsAcceptedAt,
  planTerms,
  recruiterDisclosure,
}: Props) {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isPrefilled ? 'Review & complete your profile' : 'Let’s build your profile'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Tell us about your practice in your own words — we’ll turn it into a polished landing
            page you can fine-tune afterward. Your page appears in the directory as soon as it’s complete.
          </p>
        </div>

        <Card className="p-6 sm:p-8">
          <form action={action} className="space-y-5">
            <Field label="Your name" required>
              <input
                type="text"
                name="displayName"
                required
                autoComplete="name"
                placeholder="First and last name, as clients should see it"
                defaultValue={values.displayName}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            {/* Required: a practitioner with no specialty is not listed (isProfileComplete), and
                nothing on the page said so. Enforced again in submitOnboarding. */}
            <Field label="Specialties" required hint={SPECIALTY_REQUIRED_HINT}>
              <SpecialtyComboboxField
                options={specialties}
                aliases={aliases}
                initial={initialSpecialties}
                required
                requiredMessage={SPECIALTY_REQUIRED_HINT}
              />
            </Field>

            <Field
              label="Describe your practice"
              hint="Who you help, your approach, your background and training. Write naturally — the more you share, the better your generated page. You can edit every word afterward."
            >
              <textarea
                name="draftSource"
                rows={7}
                defaultValue={values.describe}
                placeholder="e.g. Who you work with, what you help them with, where you trained, and the methods you use."
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Not "(optional)": a missing city fails isProfileComplete() → isListed(), so
                  labelling it optional invited practitioners to skip the one field that keeps
                  them out of the directory entirely. */}
              <Field label="City">
                <CityField defaultName={values.cityName} defaultState={values.cityState} />
              </Field>
              <Field label="Years in practice">
                <input
                  type="number"
                  name="yearsInPractice"
                  min={0}
                  max={70}
                  defaultValue={values.yearsInPractice ?? ''}
                  className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
                />
              </Field>
            </div>

            <Field label="Session formats">
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="telehealth"
                    defaultChecked={values.telehealth}
                    className="h-4 w-4 rounded border"
                  />
                  Telehealth / virtual
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="inPerson"
                    defaultChecked={values.inPerson}
                    className="h-4 w-4 rounded border"
                  />
                  In-person
                </label>
              </div>
            </Field>

            <fieldset className="space-y-1.5">
              <legend className="block text-xs font-medium">
                {OUTSIDE_WORK_QUESTION}
                <span className="ml-0.5 text-destructive">*</span>
              </legend>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={OUTSIDE_WORK_FIELD}
                    value="yes"
                    required
                    defaultChecked={values.openToOutsideWork === true}
                  />
                  Yes
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={OUTSIDE_WORK_FIELD}
                    value="no"
                    required
                    defaultChecked={values.openToOutsideWork === false}
                  />
                  No
                </label>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {OUTSIDE_WORK_HELPER}
              </p>
            </fieldset>

            <Separator />

            {recruiterDisclosure && (
              <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
                {recruiterDisclosure}
              </p>
            )}

            <PlanTermsSummary {...planTerms} />

            <TermsAcknowledgment acceptedAt={termsAcceptedAt} showPlanRates={planTerms.display.showPlanRates} />

            <div className="flex flex-col gap-3">
              <OnboardingSubmitButton isPrefilled={isPrefilled} />
              <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                {llmConfigured
                  ? 'AI drafts your headline, bio, and highlights from your description.'
                  : 'We’ll assemble your page from your description — refine it anytime.'}{' '}
                Booking links and offerings come next, in your dashboard.
              </p>
            </div>
          </form>
        </Card>
      </div>
    </main>
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
