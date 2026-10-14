import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANSFER_FEE_BPS,
  DEFAULT_TRANSFER_FEE_MODE,
  TransferFeeConfigError,
  loadTransferFeeConfig,
  minimumSendableShareCents,
  planTransfer,
  type TransferFeeConfig,
} from '@/lib/transfer-fee';
import { toTransferDollars } from '@/lib/referral-payouts';

const sender: TransferFeeConfig = { mode: 'charged-to-sender', bps: 300 };
const recipient: TransferFeeConfig = { mode: 'deducted-from-recipient', bps: 300 };

describe('config', () => {
  it('defaults to the conservative mode and the measured 3%', () => {
    expect(loadTransferFeeConfig({})).toEqual({ mode: 'charged-to-sender', bps: 300 });
    expect(DEFAULT_TRANSFER_FEE_MODE).toBe('charged-to-sender');
    expect(DEFAULT_TRANSFER_FEE_BPS).toBe(300);
  });
  it('reads both values from env', () => {
    expect(loadTransferFeeConfig({ WHOP_TRANSFER_FEE_MODE: 'deducted-from-recipient', WHOP_TRANSFER_FEE_BPS: '250' })).toEqual({
      mode: 'deducted-from-recipient',
      bps: 250,
    });
  });
  it('fails closed on a bad mode, a non-integer or an absurd bps', () => {
    expect(() => loadTransferFeeConfig({ WHOP_TRANSFER_FEE_MODE: 'both' })).toThrow(TransferFeeConfigError);
    expect(() => loadTransferFeeConfig({ WHOP_TRANSFER_FEE_BPS: '3.5' })).toThrow(TransferFeeConfigError);
    expect(() => loadTransferFeeConfig({ WHOP_TRANSFER_FEE_BPS: '-1' })).toThrow(TransferFeeConfigError);
    expect(() => loadTransferFeeConfig({ WHOP_TRANSFER_FEE_BPS: '999999' })).toThrow(TransferFeeConfigError);
  });
});

describe('planTransfer: deducted-from-recipient (we send the gross, the payee receives gross - fee)', () => {
  it('$10.00 at 3%: send 1000, fee 30, net 970', () => {
    expect(planTransfer(1000, recipient)).toEqual({ sendable: true, sendCents: 1000, feeCents: 30, netCents: 970, grossCents: 1000 });
  });
  it('rounds the fee UP: 1,234c at 3% is 37.02c -> 38c', () => {
    expect(planTransfer(1234, recipient)).toMatchObject({ sendable: true, sendCents: 1234, feeCents: 38, netCents: 1196 });
  });
});

describe('planTransfer: charged-to-sender (Whop bills us on top, so we send less)', () => {
  it('$10.00 at 3%: send 970, our outlay 970 + 30 = 1000, payee net 970', () => {
    expect(planTransfer(1000, sender)).toEqual({ sendable: true, sendCents: 970, feeCents: 30, netCents: 970, grossCents: 1000 });
  });
  it('1,234c: send 1198, Whop bills 36c on top (1234 outlay), fee recorded 36, net 1198', () => {
    expect(planTransfer(1234, sender)).toMatchObject({ sendable: true, sendCents: 1198, feeCents: 36, netCents: 1198 });
  });
});

describe('planTransfer: tiny and degenerate shares are NOT sent', () => {
  it('1c cannot cover a 1c fee in either mode', () => {
    for (const cfg of [sender, recipient]) {
      const p = planTransfer(1, cfg);
      expect(p.sendable).toBe(false);
      expect(p.netCents).toBe(0);
      if (!p.sendable) expect(p.reason).toMatch(/BELOW_TRANSFER_FEE/);
    }
  });
  it('zero and negative shares are not sendable', () => {
    expect(planTransfer(0, sender).sendable).toBe(false);
    expect(planTransfer(-5, recipient).sendable).toBe(false);
  });
  it('a fractional cent is a bug upstream and throws', () => {
    expect(() => planTransfer(10.5, sender)).toThrow(/whole number of cents/);
  });
  it('minimum sendable share is 2c at 3% in both modes, 1c at 0 bps', () => {
    expect(minimumSendableShareCents(sender)).toBe(2);
    expect(minimumSendableShareCents(recipient)).toBe(2);
    expect(minimumSendableShareCents({ mode: 'charged-to-sender', bps: 0 })).toBe(1);
  });
});

describe('planTransfer invariants over a sweep: at the configured rate the outlay never exceeds the gross, net = gross - fee, never negative', () => {
  it.each([0, 100, 300, 1000, 2000])('bps %i, both modes, gross 1..4000', (bps) => {
    for (const mode of ['charged-to-sender', 'deducted-from-recipient'] as const) {
      for (let g = 1; g <= 4000; g++) {
        const p = planTransfer(g, { mode, bps });
        expect(p.netCents).toBeGreaterThanOrEqual(0);
        expect(p.feeCents).toBeGreaterThanOrEqual(0);
        if (!p.sendable) continue;
        expect(p.netCents).toBe(g - p.feeCents);
        expect(p.netCents).toBeGreaterThan(0);
        if (mode === 'deducted-from-recipient') {
          expect(p.sendCents).toBe(g);
          expect(p.feeCents * 10_000).toBeGreaterThanOrEqual(g * bps);
        } else {
          expect(p.sendCents + Math.ceil((p.sendCents * bps) / 10_000)).toBeLessThanOrEqual(g);
          expect(p.netCents).toBe(p.sendCents);
        }
      }
    }
  });
});

describe('dollars vs cents boundary', () => {
  it('1,234 cents is sent as the DOLLARS value 12.34 (deducted mode, 0 bps)', () => {
    const p = planTransfer(1234, { mode: 'deducted-from-recipient', bps: 0 });
    expect(p.sendable && toTransferDollars(p.sendCents)).toBe(12.34);
  });
  it('the amount converted is sendCents, not gross: 1,234c gross in charged mode is 11.98 dollars', () => {
    const p = planTransfer(1234, sender);
    expect(p.sendable && toTransferDollars(p.sendCents)).toBe(11.98);
  });
  it('5c is 0.05 and 100c is 1, never 5 or 100', () => {
    expect(toTransferDollars(5)).toBe(0.05);
    expect(toTransferDollars(100)).toBe(1);
  });
});

describe('payee copy', () => {
  it.each(['ClientsAndReferralsSection', 'RecruitedPractitionersSection'])('%s tells the payee payouts are net of the transfer fee', (name) => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'practitioners', `${name}.tsx`), 'utf8');
    expect(src).toMatch(/Payouts are net of Whop(&apos;|')s transfer fee\./);
  });
});
