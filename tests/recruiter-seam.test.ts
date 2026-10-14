import { describe, expect, it, vi } from 'vitest';

import { getRecruiterFor, recordRecruiter } from '@/lib/recruiter';

/**
 * `getRecruiterFor` is the fee path's only view of who recruited a practitioner (spec v1.5 §5). It
 * reads L0b's immutable `recruitedById` and returns it only when that recruiter is still active.
 */

function db(recruitedById: string | null, activeIds: string[]) {
  const findFirst = vi.fn(async (a: { where: { id: string } }) =>
    activeIds.includes(a.where.id) ? { id: a.where.id } : null,
  );
  const findUnique = vi.fn(async () => ({ recruitedById }) as { recruitedById: string | null } | null);
  return { findFirst, findUnique, practitioner: { findUnique, findFirst } };
}

describe('getRecruiterFor', () => {
  it('returns the stored recruiter when still active', async () => {
    expect(await getRecruiterFor(db('R', ['R']), 'Y')).toBe('R');
  });

  it('reads the recruiter of the SERVING practitioner by id', async () => {
    const d = db('R', ['R']);
    await getRecruiterFor(d, 'Y');
    expect(d.findUnique as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({ where: { id: 'Y' }, select: { recruitedById: true } });
  });

  it('is null when nobody recruited the practitioner, and never checks activity', async () => {
    const d = db(null, ['R']);
    expect(await getRecruiterFor(d, 'Y')).toBeNull();
    expect(d.findFirst).not.toHaveBeenCalled();
  });

  it('is null when the recruiter is the practitioner themself (R != Y)', async () => {
    const d = db('Y', ['Y']);
    expect(await getRecruiterFor(d, 'Y')).toBeNull();
    expect(d.findFirst).not.toHaveBeenCalled();
  });

  it('is null when the recruiter is archived or retired — the check is bookableWhere()', async () => {
    const d = db('R', []);
    expect(await getRecruiterFor(d, 'Y')).toBeNull();
    expect(d.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'R', archivedAt: null });
  });

  it('is null for an unknown practitioner', async () => {
    const d = db('R', ['R']);
    d.findUnique.mockResolvedValue(null);
    expect(await getRecruiterFor(d, 'ghost')).toBeNull();
  });
});

describe('recordRecruiter (first wins)', () => {
  it('never replaces a recruiter already on file', () => {
    expect(recordRecruiter(null, 'R')).toBe('R');
    expect(recordRecruiter('R', 'Z')).toBe('R');
  });
});
