import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (["active", "published", "delivered", "paid", "in_stock", "received"].includes(s)) {
    return <Badge variant="success">{formatLabel(status)}</Badge>;
  }
  if (["pending", "pending_review", "low_stock", "partially_paid", "draft", "processing"].includes(s)) {
    return <Badge variant="warning">{formatLabel(status)}</Badge>;
  }
  if (["confirmed", "purchase order sent", "manufacturer fulfilment pending", "dispatched", "out for delivery", "sent to manufacturer", "acknowledged", "in production"].includes(s)) {
    return <Badge variant="info">{formatLabel(status)}</Badge>;
  }
  if (["inactive", "suspended", "cancelled", "out_of_stock", "unpaid"].includes(s)) {
    return <Badge variant="destructive">{formatLabel(status)}</Badge>;
  }
  return <Badge variant="outline">{formatLabel(status)}</Badge>;
}

function formatLabel(value: string): string {
  if (value.includes("_")) {
    return value
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}
