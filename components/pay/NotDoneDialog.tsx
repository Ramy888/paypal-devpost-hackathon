"use client";

import { useRef } from "react";

// "Not done yet": an outlined button that opens a dialog to say what is missing, then submits.
export function NotDoneDialog({
  action,
  label = "Not done yet",
  title,
  prompt,
  submitLabel = "Send",
  required = true,
}: {
  action: (form: FormData) => void | Promise<void>;
  label?: string;
  title: string;
  prompt: string;
  submitLabel?: string;
  required?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="rounded-md border border-pending/50 px-3 py-1.5 text-sm font-semibold text-pending hover:bg-pending-soft"
      >
        {label}
      </button>
      <dialog
        ref={ref}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-card p-0 text-ink shadow-xl backdrop:bg-ink/40"
        onClick={(e) => e.target === ref.current && ref.current?.close()}
      >
        <form action={action} className="grid gap-4 p-5" onSubmit={() => ref.current?.close()}>
          <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted">{prompt}</span>
            <textarea name="note" rows={4} maxLength={1000} dir="auto" required={required} autoFocus className="w-full min-w-0 rounded-md border border-line bg-paper px-3 py-2" />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => ref.current?.close()} className="rounded-md px-3 py-2 text-sm font-semibold text-muted hover:bg-line">
              Cancel
            </button>
            <button className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white">{submitLabel}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
