import type { Step } from "@/components/StepBar";

// The client journeys, so every page in one shows the same steps.
export const CONNECT_STEPS = ["Approve on PayPal", "Save your key", "Connect assistant", "First payment"];
export const RETAINER_STEPS = ["Review offer", "Approve on PayPal", "First month paid", "Monthly billing"];

/** A payment schedule: review the dates, approve them, then milestones get paid one by one. */
export function scheduleSteps({ approved, autopay, kind, paid, total, held }: { approved: boolean; autopay: boolean; kind: string; paid: number; total: number; held: number }): Step[] {
  const allPaid = paid === total;
  return [
    { title: "Review dates", state: approved ? "done" : "active", status: approved ? "Reviewed" : "Now" },
    { title: "Approve", state: approved ? "done" : "todo", status: approved ? (autopay ? "Auto-pay on" : "You pay each") : undefined },
    {
      title: `${kind[0].toUpperCase()}${kind.slice(1)}s paid`,
      state: !approved ? "todo" : allPaid ? "done" : "active",
      status: approved ? `${paid} of ${total} paid${held ? ` · ${held} on hold` : ""}` : undefined,
    },
    { title: "All paid", state: allPaid && approved ? "done" : "todo", status: allPaid && approved ? "Done" : undefined },
  ];
}
