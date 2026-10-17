import { PublicShell } from "@/components/PublicShell";

export default function PayLayout({ children }: LayoutProps<"/pay">) {
  return (
    <PublicShell note="PayPal charges you and sends every receipt. CollectPilot never sees your PayPal password or card details. You can turn off auto-pay here, or remove CollectPilot in your PayPal account, at any time.">
      {children}
    </PublicShell>
  );
}
