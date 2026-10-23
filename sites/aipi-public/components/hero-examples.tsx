"use client";

import { useState } from "react";
import { ReleaseExample } from "./release-example";
import { TrustBoundaryExample } from "./trust-boundary-example";

export function HeroExamples() {
  const [view, setView] = useState<"trust" | "release">("trust");
  return <div className="hero-examples">
    <div className="hero-example-switch" role="group" aria-label="Choose a product example">
      <button type="button" aria-pressed={view === "trust"} onClick={() => setView("trust")}>01 · Context trust</button>
      <button type="button" aria-pressed={view === "release"} onClick={() => setView("release")}>02 · Version compatibility</button>
    </div>
    {view === "trust" ? <TrustBoundaryExample /> : <ReleaseExample />}
  </div>;
}
