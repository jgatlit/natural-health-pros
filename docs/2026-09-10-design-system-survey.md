# Design-system survey — Theme D "Midnight Navy"

| | |
|---|---|
| **Date** | 2026-09-10 |
| **Scope** | Read-only survey of the applied visual system. No code changed. |
| **Sources read** | `src/app/globals.css`, `src/app/layout.tsx`, `src/components/ui/*`, `src/components/frontier/*`, `src/app/page.tsx` |
| **Visual reference** | https://claude.ai/code/artifact/452b8e62-9b1d-4b56-8488-e7bdbdf4a814 — every token rendered from its literal repo value (private artifact, Jonathan's account) |
| **Related memory** | `gotcha_theme_d_dark_and_cta_tier` |

## The system as it stands

Theme D "Midnight Navy", applied 2026-05-29 (`8cf4f17` / `5a23aff`), consumed from
`cms.chem.dev/hhe-directory`. It arrives in three stacked layers, all in `src/app/globals.css`:

1. **Semantic contract** — the shadcn slot names (15 paired tokens), authored in OKLCH. The
   `@theme` block above them is wiring that maps them to Tailwind utilities and should not be
   edited; the `:root` block below is the only thing a re-brand touches.
2. **Frontier layer** — 9 raw hex color tokens, 6 gradients, 6 shadows, carried verbatim from the
   CMS `tokens.json`. These express range the flat semantic slots can't: `--field-deep` exists
   because `--primary` has no darker neighbour.
3. **Utility voice** — 6 named classes (`.eyebrow`, `.field-surface`, `.hero-wash`, `.sage-wash`,
   `.rose-cta-surface`, `.glow-rose`).

Type: Playfair Display for every heading and practitioner name, Inter for body and UI, Geist Mono
(local `.woff`) for data. One `--radius` token (0.625rem) generates the scale by subtraction.

**Shadows are navy-tinted on purpose** — every elevation uses `rgba(44, 74, 110, …)`, the rose
glow `rgba(196, 57, 110, …)`. The CSS comment marks this as deliberate; substituting Tailwind's
neutral black scale reads as grime against the navy-tinted neutrals.

**Focus is a contract**, per the comment in `globals.css`: 2px rose at 3px offset, never
suppressed, switching to `--rose-light` under `[data-surface='field']`. Note that the attribute —
not a class — drives the switch, so a dark section must carry `data-surface="field"` and not just
the background.

The system is genuinely one-file swappable: all color lives in `globals.css`, with no hex, oklch,
or rgb literal anywhere in `src/**/*.tsx`.

## Gap 1 — the `.dark` block is unbranded, and unreachable

`.dark` has every shadcn slot filled, so it reads as a finished dark theme. It is not:

- Values are still default shadcn zinc. `--primary` is `oklch(0.922 0 0)` — a light grey at zero
  chroma. Only `--cta` was carried across from the brand.
- The **entire frontier layer** (9 colors, 6 gradients, 6 shadows) is declared in `:root` only and
  never redefined, so it would bleed light-theme values onto a dark ground.

It is dormant rather than broken: the variant is `@custom-variant dark (&:is(.dark *))` and
nothing in the app ever sets that class — no toggle, no theme provider (verified by grep).

**Implication**: "add a dark mode toggle" is a brand project, not a switch. Flipping the class
today ships an unbranded site with light-theme gradients on navy.

## Gap 2 — `--cta` has no `Button` variant, so nothing ranks the actions

`--cta` (rose magenta `#C4396E`) is a first-class token: declared in `:root`, mapped in `@theme`,
resolving as `bg-cta` / `text-cta`. But `buttonVariants` in `src/components/ui/button.tsx` stops
at six variants — default, outline, secondary, ghost, destructive, link — and `cta` is not one of
them. No call site uses `variant="cta"`.

Six call sites hand-roll it instead, in two divergent visual languages:

| Treatment | Spec | Files |
|---|---|---|
| Gradient rose | h-12, `--gradient-rose-cta`, rose glow on hover | `app/page.tsx` (×2), `components/site/HeroSearch.tsx` — identical class string duplicated |
| Flat rose | `bg-cta`, opacity on hover, `p-4` and `h-10` | `PractitionerCTAs`, `OfferingCard`, `BookingChooser` |

**Implication**: full-saturation rose is the *only* CTA tier the system offers. There is no quiet
rose to demote a lesser action to, and no rule naming one hero action per view — so a profile
rendering several booking actions renders each at hero weight.

⚠️ **This is a structural candidate for the open "two pink buttons" item on Amy's profile, not a
confirmed diagnosis.** It is consistent with the symptom; nobody has reproduced the bug against
that profile's actual data, and this survey did not attempt to.

**Suggested fix** (not implemented): add `cta` and a quieter `cta-secondary` to `buttonVariants`,
then migrate the six call sites. That makes the hierarchy enforceable rather than remembered, and
stops a seventh hand-rolled class string from appearing.

## Gap 3 — `docs/P2-design-system-prep.md` §4 is stale

It maps forest green to `--primary` and states branding is deferred with zinc still shipping.
Both were true on 2026-05-28 and superseded the next day when Midnight Navy was chosen and
applied. **§1's bridge-point explanation is still accurate and worth keeping**, which is exactly
what makes the file read as current. CLAUDE.md already flags this; recorded here so the survey is
self-contained.

## Not covered

- No visual regression run against production; this is a source read, not a render check.
- Mobile/responsive behaviour of the system was not audited.
- The `.dark` block's contrast was not evaluated, since it is unreachable.
