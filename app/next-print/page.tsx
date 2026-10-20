import type { Metadata } from "next";
import { MosiDashboard } from "../components/MosiDashboard";

export const metadata: Metadata = {
  title: "Next Print · MOSI",
  description:
    "Market-implied distributions for upcoming CPI, PCE, jobs, unemployment and GDP releases.",
};

export default function NextPrintPage() {
  return <MosiDashboard screen="prints" />;
}
