export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight">HHE Directory</h1>
        <p className="mt-4 text-lg text-neutral-600">
          HHE-students-first practitioner directory.
        </p>
        <p className="mt-8 text-sm text-neutral-500">
          Phase 0 — foundation scaffolding. See{' '}
          <code className="rounded bg-neutral-100 px-1.5 py-0.5">README.md</code> for
          the build plan.
        </p>
      </div>
    </main>
  );
}
