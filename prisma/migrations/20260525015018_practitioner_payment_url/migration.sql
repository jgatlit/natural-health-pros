-- Wedge 2C — practitioner-owned payment URL (Whop / Stripe / etc.)
ALTER TABLE "Practitioner" ADD COLUMN "paymentUrl" TEXT;
