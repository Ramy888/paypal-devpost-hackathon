"use client";

import { useId, useState } from "react";

// Read-only value with a copy button. Falls back to selecting the text if the clipboard is blocked.
export function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "select">("idle");
  const id = useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      setTimeout(() => setState("idle"), 2000);
    } catch {
      (document.getElementById(id) as HTMLTextAreaElement | HTMLInputElement | null)?.select();
      setState("select");
    }
  }

  const field = "w-full min-w-0 resize-none rounded-md border border-line bg-paper px-3 py-2 font-mono text-[13px] text-ink";
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-muted">
          {label}
        </label>
        <button type="button" onClick={copy} className="rounded-md px-2 py-1 text-xs font-medium text-cleared hover:bg-cleared-soft">
          {state === "copied" ? "Copied" : state === "select" ? "Selected, now copy it" : "Copy"}
        </button>
      </div>
      {multiline ? (
        <textarea id={id} readOnly value={value} rows={value.split("\n").length} className={field} />
      ) : (
        <input id={id} readOnly value={value} className={field} />
      )}
    </div>
  );
}
