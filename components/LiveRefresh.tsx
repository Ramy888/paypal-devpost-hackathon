"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the page when the live feed reports a change it cares about (by event-type prefix).
export function LiveRefresh({ prefixes }: { prefixes: string[] }) {
  const router = useRouter();
  useEffect(() => {
    const source = new EventSource("/api/stream");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = (msg) => {
      const type = String(JSON.parse(msg.data)?.event_type ?? "");
      if (!prefixes.some((p) => type.startsWith(p))) return;
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 300); // a burst of events refreshes once
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [router, prefixes]);
  return null;
}
