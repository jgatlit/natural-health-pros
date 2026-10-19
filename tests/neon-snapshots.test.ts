import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSnapshot, deleteSnapshot, listSnapshots } from '@/lib/neon-snapshots';

/**
 * The paths are asserted literally because a wrong one is not a type error: the first production
 * run called `/branches/{id}/snapshots`, which Neon answers with a 404, and rotation failed.
 * Shapes follow Neon's v2 OpenAPI spec and a read-only GET of the live project (2026-10-19).
 */
const API = 'https://console.neon.tech/api/v2';
const KEY = 'test-key';
const PROJECT = 'late-leaf-76985577';
const BRANCH = 'br-jolly-thunder-aplg467g';

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listSnapshots', () => {
  it('GETs the project-level snapshots route, never a branch-scoped one', async () => {
    fetchMock.mockResolvedValueOnce(json({ snapshots: [] }));

    await listSnapshots(KEY, PROJECT, BRANCH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/projects/${PROJECT}/snapshots`);
    expect(init.method).toBeUndefined();
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("returns only the snapshots whose source_branch_id is this branch", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        snapshots: [
          {
            id: 'snap-summer-union-ap5lwqqr',
            name: 'main at 2026-08-27 23:07:49 UTC (manual)',
            source_branch_id: BRANCH,
            created_at: '2026-08-27T23:07:49Z',
            manual: true,
          },
          { id: 'snap-other', name: 'preview', source_branch_id: 'br-other', created_at: 'x' },
          { id: 'snap-unattributed', name: 'no source', created_at: 'x' },
        ],
      }),
    );

    const got = await listSnapshots(KEY, PROJECT, BRANCH);

    expect(got.map((s) => s.id)).toEqual(['snap-summer-union-ap5lwqqr']);
  });

  it('treats a missing snapshots array as empty', async () => {
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(listSnapshots(KEY, PROJECT, BRANCH)).resolves.toEqual([]);
  });

  it('throws with the status and body on a non-2xx, so the route never deletes or creates', async () => {
    fetchMock.mockResolvedValueOnce(new Response('this route does not exist', { status: 404 }));

    await expect(listSnapshots(KEY, PROJECT, BRANCH)).rejects.toThrow(
      `Neon GET /projects/${PROJECT}/snapshots -> 404: this route does not exist`,
    );
  });
});

describe('deleteSnapshot', () => {
  it('DELETEs the project-level snapshot route and accepts the 202 operations body', async () => {
    fetchMock.mockResolvedValueOnce(json({ operations: [] }, 202));

    await deleteSnapshot(KEY, PROJECT, 'snap-summer-union-ap5lwqqr');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/projects/${PROJECT}/snapshots/snap-summer-union-ap5lwqqr`);
    expect(init.method).toBe('DELETE');
  });

  it('throws on failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 403 }));
    await expect(deleteSnapshot(KEY, PROJECT, 'snap-x')).rejects.toThrow('-> 403: nope');
  });
});

describe('createSnapshot', () => {
  it('POSTs the branch-scoped singular /snapshot route with the name URL-encoded', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        snapshot: { id: 'snap-new', name: 'weekly 1/2', source_branch_id: BRANCH, created_at: 'x' },
        operations: [],
      }),
    );

    const got = await createSnapshot(KEY, PROJECT, BRANCH, 'weekly 1/2');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/projects/${PROJECT}/branches/${BRANCH}/snapshot?name=weekly%201%2F2`);
    expect(init.method).toBe('POST');
    expect(got.id).toBe('snap-new');
  });

  it('surfaces a plan-limit refusal with its body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('snapshot limit reached', { status: 422 }));
    await expect(createSnapshot(KEY, PROJECT, BRANCH, 'w')).rejects.toThrow(
      '-> 422: snapshot limit reached',
    );
  });
});
