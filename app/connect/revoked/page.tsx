import type { Metadata } from "next";
import { Notice } from "@/components/connect/Notice";

export const metadata: Metadata = { title: "Access revoked · CollectPilot" };

export default function RevokedPage() {
  return (
    <Notice
      title="Access revoked"
      body="The PayPal permission is deleted and your agent key no longer works. Invoices will wait for you to pay them yourself."
      action={{ href: "/connect", label: "Connect again" }}
    />
  );
}
