import type { Metadata } from "next";
import { MosiDashboard } from "../components/MosiDashboard";

export const metadata: Metadata = {
  title: "Recession · MOSI",
  description:
    "Prediction-market recession odds alongside the Sahm rule, yield curve, jobless claims and credit spreads.",
};

export default function RecessionPage() {
  return <MosiDashboard screen="recession" />;
}
