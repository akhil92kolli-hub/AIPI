"use client";

import { useState } from "react";

const scenarios = [
  {
    id: "current",
    label: "Today in production",
    frontend: "F0 · deployed",
    proof: "B1 + F0 · failed",
    verdict: "Block backend B1",
    detail: "The currently deployed storefront still expects total. A passing check against a proposed F1 does not make this pair compatible.",
    tone: "blocked",
  },
  {
    id: "pending",
    label: "Frontend PR pending",
    frontend: "F1 · proposed; F0 · deployed",
    proof: "B1 + F1 · passed; B1 + F0 · failed",
    verdict: "Still block backend B1",
    detail: "The repair exists in a PR, but users are still running F0. The release decision must include every active deployment cohort.",
    tone: "blocked",
  },
  {
    id: "ready",
    label: "Compatible rollout",
    frontend: "F1 · deployed; F0 · retired",
    proof: "B1 + F1 · passed at pinned artifacts",
    verdict: "Eligible for gate review",
    detail: "The proposed release policy could permit B1 after trusted deployment observations and exact pair checks are accepted. Other unknown obligations still block.",
    tone: "review",
  },
] as const;

export function ReleaseExample() {
  const [selection, setSelection] = useState<(typeof scenarios)[number]["id"]>("current");
  const current = scenarios.find((item) => item.id === selection) ?? scenarios[0];

  return <div className="release-example" aria-label="Illustrative cross-repository release decision">
    <div className="release-example-head"><span>ILLUSTRATIVE RELEASE MATRIX</span><span>Proposed gate behavior</span></div>
    <div className="release-example-tabs" role="group" aria-label="Choose a release scenario">
      {scenarios.map((item) => <button type="button" key={item.id} onClick={() => setSelection(item.id)} aria-pressed={selection === item.id}>{item.label}</button>)}
    </div>
    <div className="release-example-grid">
      <div><small>BACKEND CANDIDATE</small><strong>Orders B1</strong><span>response field total removed</span></div>
      <div><small>FRONTEND STATE</small><strong>{current.frontend}</strong><span>Storefront checkout</span></div>
      <div><small>PAIR EVIDENCE</small><strong>{current.proof}</strong><span>exact versions required</span></div>
    </div>
    <div className={`release-example-verdict ${current.tone}`} role="status"><strong>{current.verdict}</strong><p>{current.detail}</p></div>
    <p className="release-example-note">This example explains the planned gate. It is not a live deployment decision or proof of production enforcement.</p>
  </div>;
}
