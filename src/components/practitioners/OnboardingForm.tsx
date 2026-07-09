import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpecialtyComboboxField } from '@/components/practitioners/SpecialtyComboboxField';

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  isPrefilled: boolean;
  llmConfigured: boolean;
  values: {
    displayName: string;
    describe: string;
    cityId: string;
    yearsInPractice: number | null;
    telehealth: boolean;
    inPerson: boolean;
  };
  cities: { id: string; name: string; state: string }[];
  specialties: { id: string; name: string }[];
  aliases: { label: string; specialtyId: string }[];
  initialSpecialties: { specialtyId: string; rawLabel: string }[];
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
  cities,
  specialties,
  aliases,
  initialSpecialties,
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
            page you can fine-tune afterward. Your page stays private until it’s complete.
          </p>
        </div>

        <Card className="p-6 sm:p-8">
          <form action={action} className="space-y-5">
            <Field label="Your name" required>
              <input
                type="text"
                name="displayName"
                required
                defaultValue={values.displayName}
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
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
                placeholder="e.g. I'm a functional nutritionist who helps women in perimenopause with fatigue, gut issues, and hormone balance. I trained at… I use HTMA, targeted supplementation, and mindset coaching…"
                className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
              />
            </Field>

            <Field
              label="Specialties"
              hint="Search the curated list or type your own — we keep your wording on your profile and match it to the right category."
            >
              <SpecialtyComboboxField
                options={specialties}
                aliases={aliases}
                initial={initialSpecialties}
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="City (optional)">
                <select
                  name="cityId"
                  defaultValue={values.cityId}
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

            <Separator />

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                {isPrefilled ? 'Regenerate my page' : 'Generate my page'}
              </button>
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
