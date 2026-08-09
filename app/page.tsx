import type { Metadata } from "next";
import { MosiDashboard } from "./components/MosiDashboard";

export const metadata: Metadata = {
  title: "The Fed · MOSI",
  description:
    "Forward rate expectations and inflation signals from futures, options, and prediction markets.",
};

export default function FedPage() {
  return <MosiDashboard screen="fed" />;
}
