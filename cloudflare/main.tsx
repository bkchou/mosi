import React from "react";
import { createRoot } from "react-dom/client";
import { MosiDashboard } from "../app/components/MosiDashboard";
import "../app/globals.css";

const screen = window.location.pathname.startsWith("/ai-models") ? "models" : "fed";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MosiDashboard screen={screen} />
  </React.StrictMode>,
);
