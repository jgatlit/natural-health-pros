# Plan A vs Plan B — one-year projection for a single practitioner

> Generated 2026-09-18. Every figure is computed from `src/lib/pricing-plans.ts`, so it moves when
> the config moves. Nothing here is a forecast of platform revenue — it is what ONE practitioner
> pays under each plan at a given volume.

## Plans as configured (2026-09-18)

| | Plan A | Plan B |
|---|---|---|
| Monthly fee | $39 | none |
| First NHP-sourced session | platform 20% | **platform 40% (practitioner 60%)** |
| Sessions after that | platform 20%, while the 1-year attribution claim is live | platform 0% — booked privately |
| Whop account | required | required |

## Assumptions, and where each comes from

1. **Session price $100**, sensitivity at **$75** and **$150**. Amy reasoned from $100 on the
   2026-09-14 call ("that's a twenty dollar difference on a hundred dollars"); HHE's stated
   standard is first sessions under $100, promoted hardest at $75 or less (2026-05-28 call).
2. **Sourced volume 0 / 1 / 2 / 4 / 8 new NHP-sourced clients per month**, held flat for 12
   months. Practitioner income was described as swinging from ~$100 to ~$2,000/mo, so the low end
   is the realistic case and the high end is aspirational.
3. **Follow-up sessions per sourced client: 0 or 2.** This is the assumption that decides the
   answer, and it was never pinned down on any call. 0 = the Plan B story as told ("book them
   privately after that"). 2 = the client keeps rebooking through the platform.
4. **Only NHP-sourced work is counted.** The practitioner's own clients are 0% on both plans and
   are excluded entirely.
5. Whop/processing fees excluded — identical on both plans (~$0.72 on the live $10 test).
6. No churn, no refunds, no price changes mid-year.


### Session price $75

**Follow-up sessions per sourced client: 0**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $900 | $648 | $360 | $252 | $540 | Plan B |
| 2 | $1,800 | $828 | $720 | $972 | $1,080 | Plan B |
| 4 | $3,600 | $1,188 | $1,440 | $2,412 | $2,160 | Plan A |
| 8 | $7,200 | $1,908 | $2,880 | $5,292 | $4,320 | Plan A |

**Follow-up sessions per sourced client: 2**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $2,700 | $1,008 | $360 | $1,692 | $2,340 | Plan B |
| 2 | $5,400 | $1,548 | $720 | $3,852 | $4,680 | Plan B |
| 4 | $10,800 | $2,628 | $1,440 | $8,172 | $9,360 | Plan B |
| 8 | $21,600 | $4,788 | $2,880 | $16,812 | $18,720 | Plan B |


### Session price $100

**Follow-up sessions per sourced client: 0**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $1,200 | $708 | $480 | $492 | $720 | Plan B |
| 2 | $2,400 | $948 | $960 | $1,452 | $1,440 | Plan A |
| 4 | $4,800 | $1,428 | $1,920 | $3,372 | $2,880 | Plan A |
| 8 | $9,600 | $2,388 | $3,840 | $7,212 | $5,760 | Plan A |

**Follow-up sessions per sourced client: 2**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $3,600 | $1,188 | $480 | $2,412 | $3,120 | Plan B |
| 2 | $7,200 | $1,908 | $960 | $5,292 | $6,240 | Plan B |
| 4 | $14,400 | $3,348 | $1,920 | $11,052 | $12,480 | Plan B |
| 8 | $28,800 | $6,228 | $3,840 | $22,572 | $24,960 | Plan B |


### Session price $150

**Follow-up sessions per sourced client: 0**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $1,800 | $828 | $720 | $972 | $1,080 | Plan B |
| 2 | $3,600 | $1,188 | $1,440 | $2,412 | $2,160 | Plan A |
| 4 | $7,200 | $1,908 | $2,880 | $5,292 | $4,320 | Plan A |
| 8 | $14,400 | $3,348 | $5,760 | $11,052 | $8,640 | Plan A |

**Follow-up sessions per sourced client: 2**

| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Better |
|---|---|---|---|---|---|---|
| 0 | $0 | $468 | $0 | $-468 | $0 | Plan B |
| 1 | $5,400 | $1,548 | $720 | $3,852 | $4,680 | Plan B |
| 2 | $10,800 | $2,628 | $1,440 | $8,172 | $9,360 | Plan B |
| 4 | $21,600 | $4,788 | $2,880 | $16,812 | $18,720 | Plan B |
| 8 | $43,200 | $9,108 | $5,760 | $34,092 | $37,440 | Plan B |


### Break-even (clients/mo where Plan A becomes cheaper)

| Session price | 0 follow-ups | 2 follow-ups |
|---|---|---|
| $75 | 2.60 | never |
| $100 | 1.95 | never |
| $150 | 1.30 | never |

## What the projection actually says

**1. Plan A only wins when platform-sourced clients do NOT rebook through the platform.**
At $100 with no follow-ups, Plan A overtakes Plan B at about **2 sourced clients a month**
(~$195/mo of sourced business). That is the case Amy modelled.

**2. If sourced clients DO rebook on the platform, Plan A never wins — at any price, at any
volume.** Plan A's 20% applies to every session for the whole 1-year attribution window, while
Plan B's 40% is charged once per client and never again. Two follow-ups per client is enough to
make 20%-forever more expensive than 40%-once, and the gap widens with volume: at 8 clients/mo and
$100 sessions, Plan A costs the practitioner **$6,228/yr** against Plan B's **$3,840/yr**.

This is a real commercial asymmetry, not a modelling artifact, and it cuts against the pitch that
Plan A is the option for practitioners doing steady volume with us. Worth putting to Amy before
the plans are announced.

**3. Amy's "$150/mo break-even" was computed at $29/mo, not $39.** At $29 it is ~$145/mo of
sourced business, which is where her number came from. At the repriced $39 it is ~$195/mo. If the
$150 figure is going into practitioner-facing copy, either the price or the copy needs to move.

**4. Plan A has a floor loss of $468/yr.** A practitioner who subscribes and gets sent nothing
pays $468 for the year. That is precisely the outcome practitioners told Amy they would cancel
over after one or two empty months.

## Levers, if the shape above is not the intended one

- Cap Plan A's 20% at the first N sessions per client, which restores the "steady volume is
  cheaper on Plan A" story.
- Or drop Plan A's ongoing rate below 20% while keeping the monthly fee.
- Or shorten Plan A's attribution window below 12 months.

All three are env changes, not code changes.
