import type { Metadata } from "next";
import { Notice } from "@/components/connect/Notice";

export const metadata: Metadata = { title: "Nothing changed · CollectPilot" };

export default function CancelledPage() {
  return (
    <Notice
      title="Nothing changed"
      body="You left PayPal before approving, so your agent has no access and no money moved."
      action={{ href: "/connect", label: "Start again" }}
    />
  );
}
