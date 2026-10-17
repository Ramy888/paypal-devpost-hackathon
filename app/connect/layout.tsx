import { PublicShell } from "@/components/PublicShell";

export default function ConnectLayout({ children }: LayoutProps<"/connect">) {
  return (
    <PublicShell home="/connect" note="CollectPilot never sees your PayPal password or card details. Every payment is made and receipted by PayPal.">
      {children}
    </PublicShell>
  );
}
