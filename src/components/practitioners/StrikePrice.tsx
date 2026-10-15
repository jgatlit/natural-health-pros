/**
 * A price beside the regular price it replaces: "~~$39~~ $29/mo". Screen readers mostly do not
 * announce a strikethrough, so the struck figure is hidden from them and they hear "was $39, now
 * $29/mo" instead. With no list price it renders the price alone.
 */
export function StrikePrice({ listLabel, priceLabel }: { listLabel?: string | null; priceLabel: string }) {
  if (!listLabel) return <>{priceLabel}</>;
  return (
    <>
      <s aria-hidden className="mr-1 font-normal text-muted-foreground">
        {listLabel}
      </s>
      <span className="sr-only">was {listLabel}, now </span>
      {priceLabel}
    </>
  );
}
