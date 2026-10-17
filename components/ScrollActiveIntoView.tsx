"use client";

import { useEffect } from "react";

// On phones the owner nav is a swipeable row; bring the current page's pill into view on load.
export function ScrollActiveIntoView({ navId }: { navId: string }) {
  useEffect(() => {
    const nav = document.getElementById(navId);
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && active && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
  }, [navId]);
  return null;
}
