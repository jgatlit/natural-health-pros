# P2 — Design-system / CMS swap prep

> Readiness brief for consuming the `cms.chem.dev` design system (P2) and applying the locked
> brand. Goal: when the CMS slug lands, applying the brand is a **token swap**, not a rewrite.
> Branding is currently **deferred** (operator decision 2026-05-29) — `globals.css` still ships
> default shadcn zinc. This doc is preparation only; it does **not** apply the brand.

## 1. The bridge point (where tokens land)

`src/app/globals.css` themes via **Tailwind v4 `@theme` + CSS custom properties** (no
`tailwind.config.ts`). Two layers:

- **`@theme { --color-* : var(--*) }`** — maps semantic vars → Tailwind color utilities
  (`bg-primary`, `text-muted-foreground`, `border`, …). **Do not touch** — it's the wiring.
- **`:root { --* : oklch(...) }`** (+ `.dark`) — the actual values. **This is the only block the
  CMS swap edits.** Overwrite these and the entire app restyles.

The full semantic contract every component already consumes:

| Var (light + dark) | Role |
|---|---|
| `--background` / `--foreground` | page surface + body text |
| `--card` / `--card-foreground` | cards, rails, list rows |
| `--popover` / `--popover-foreground` | dropdowns (combobox) |
| `--primary` / `--primary-foreground` | **brand primary** — booking CTA, default badges, buttons |
| `--secondary` / `--secondary-foreground` | secondary badges/chips |
| `--muted` / `--muted-foreground` | section labels, helper text, meta rows |
| `--accent` / `--accent-foreground` | hover states |
| `--destructive` / `--destructive-foreground` | errors |
| `--border` / `--input` / `--ring` | borders, inputs, focus rings |

The locked brand maps cleanly: **forest-green → `--primary`**, **red-hot-pink → `--accent`**
(and/or a dedicated brand-accent), **sage → `--secondary`**, **white → `--background`** (already).

## 2. Token-drivenness audit (2026-05-29)

- **Public brand surfaces are 100% token-driven** — landing page (`PractitionerHero`,
  `PractitionerCTAs`), `/search`, `/`, profile. No hard-coded colors. A `:root` swap fully restyles them.
- **No raw hex / `oklch(` / `rgb(` anywhere in `src/**/*.tsx`.** Only `globals.css` holds values.
- **Only non-token colors** = semantic status banners (intentional, not brand):
  - `src/app/practitioners/[slug]/edit/page.tsx` — amber "profile in progress" / green "complete".
  - `src/app/admin/connected-accounts/page.tsx` — amber "pending Whop access".
  - These are operator/practitioner-facing status states (warning/success), conventionally
    palette-based. **Optional:** if the design system defines success/warning, add `--success` /
    `--warning` tokens to `:root` + `@theme` and replace the amber/green classes. Not required for
    the public brand swap.

## 3. Swap procedure (when the slug arrives)

1. **Pull the slug's tokens** — `tokens.json` (DTCG) from `vps:~/apps/CMS/projects/{slug}/`
   (or the published `tokens.css`). Ref: `~/.claude/projects/-home-jgatlit-Documents-aiChemist-agency/memory/reference_cms_design_pipeline.md`.
2. **Flatten DTCG → the `:root` var names** above. This is a **static one-time mapping into
   `globals.css :root`**, NOT the CMS ShowcasePage runtime injection.
3. **Convert to OKLCH** to match the file convention.
4. **Verify** — Playwright screenshots of `/`, `/search`, `/practitioners/[slug]` (desktop +
   390px mobile); the CMS pipeline's ≥90/100 quality gate is the standard. Re-use
   `docs/landing-built/` as the before/after baseline.

## 4. Candidate brand OKLCH (so P-Brand can ship before the slug, if desired)

Approximate conversions of the locked palette — **operator/CMS to confirm exact values**. Drop into
`:root` (light) to de-risk demos immediately; P2 refines from the CMS source. Leave `.dark` as-is
or derive later.

```css
/* locked brand — CANDIDATE values, confirm against CMS */
--background: oklch(1 0 0);            /* white — already */
--primary: oklch(0.45 0.11 152);      /* forest green ("over sage") */
--primary-foreground: oklch(0.985 0 0);
--secondary: oklch(0.86 0.04 145);    /* sage */
--secondary-foreground: oklch(0.30 0.04 152);
--accent: oklch(0.65 0.24 358);       /* red-hot-pink */
--accent-foreground: oklch(0.985 0 0);
--ring: oklch(0.45 0.11 152);         /* focus = primary */
```

## 5. Open decisions (the inbound CMS decision)

- **Which `cms.chem.dev` slug** carries the HHE/Amoria design system to consume?
- **Where is the brand authored** — already in the CMS slug, or authored here (§4) and
  round-tripped back into the CMS as the canonical system for "Amoria"?
- **Secondary color** — still ambiguous in the meeting record (**sage vs navy**); §4 assumes sage
  per the locked-memory string. Confirm with Amy.
- **Status tokens** — tokenize `--success`/`--warning` (§2) or leave palette amber/green?

## 6. Why this is low-risk

The build was authored token-first specifically for this swap: the hero, booking CTA, chips, search
facets, and combobox all reference `--primary/--secondary/--accent/--muted/--border`. Once `:root`
carries the brand, every surface updates in one edit — no component changes. The two-column
Variation B layout (client go-forward) is independent of color, so the design-system import is
purely a palette/type concern.
