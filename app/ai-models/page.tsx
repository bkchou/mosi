import type { Metadata } from "next";
import { MosiDashboard } from "../components/MosiDashboard";

export const metadata: Metadata = {
  title: "AI Models · MOSI",
  description:
    "Market-implied release windows for the next generation of frontier AI models.",
};

export default function ModelsPage() {
  return <MosiDashboard screen="models" />;
}
