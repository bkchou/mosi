import React from "react";
import { createRoot } from "react-dom/client";
import { MosiDashboard, screenForPath, screenTitle } from "../app/components/MosiDashboard";
import "../app/globals.css";

const screen = screenForPath(window.location.pathname);
document.title = screenTitle(screen);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MosiDashboard screen={screen} />
  </React.StrictMode>,
);
