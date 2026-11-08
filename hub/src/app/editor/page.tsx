import { Suspense } from "react";
import EditorView from "./EditorView";

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-3xl px-6 py-16 text-[var(--muted)]">
          Načítavam editor…
        </main>
      }
    >
      <EditorView />
    </Suspense>
  );
}
