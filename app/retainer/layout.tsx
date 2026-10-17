import { PublicShell } from "@/components/PublicShell";

export default function RetainerLayout({ children }: LayoutProps<"/retainer">) {
  return (
    <PublicShell note="PayPal bills you and sends every receipt. CollectPilot never sees your PayPal password or card details, and you can cancel the retainer in your PayPal account at any time.">
      {children}
    </PublicShell>
  );
}
