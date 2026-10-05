import type { Metadata } from "next";
import { Notice } from "@/components/connect/Notice";

export const metadata: Metadata = { title: "Couldn't connect · CollectPilot" };

const REASONS: Record<string, string> = {
  NO_PENDING: "We couldn't find an approval started in this browser. Start from the same browser you used to open PayPal.",
  ALREADY_USED: "This approval was already completed. Your agent is connected.",
  EXPIRED: "The approval took longer than an hour and expired. Nothing was charged.",
  NOT_APPROVED: "PayPal hasn't confirmed your approval, so nothing was set up and nothing was charged.",
  BAD_LIMIT: "Please choose one of the offered limits.",
  PAYPAL_UNAVAILABLE: "PayPal didn't respond as expected. Nothing was charged. Please try again in a minute.",
};

export default async function ProblemPage({ searchParams }: PageProps<"/connect/problem">) {
  const { reason } = await searchParams;
  const body = REASONS[typeof reason === "string" ? reason : ""] ?? REASONS.PAYPAL_UNAVAILABLE;
  return <Notice title="We couldn't connect your agent" body={body} action={{ href: "/connect", label: "Start again" }} />;
}
