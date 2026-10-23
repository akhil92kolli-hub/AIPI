const sendButton = document.querySelector("#sendRequest");
const terminal = document.querySelector(".terminal-card");
const diagnosis = document.querySelector("#diagnosis");
const tabs = [...document.querySelectorAll(".terminal-tabs button")];

sendButton?.addEventListener("click", () => {
  if (terminal.classList.contains("loading")) return;
  terminal.classList.remove("success");
  terminal.classList.add("loading");
  sendButton.disabled = true;
  sendButton.firstChild.textContent = "Analyzing ";
  diagnosis.querySelector("strong").textContent = "AI-PI is collecting evidence";
  diagnosis.querySelector("p").textContent = "Comparing consumer, route, validator, schema, and tests…";
  diagnosis.querySelector(".analysis-badge").textContent = "···";

  window.setTimeout(() => {
    terminal.classList.remove("loading");
    terminal.classList.add("success");
    sendButton.disabled = false;
    sendButton.firstChild.textContent = "Diagnose ";
    diagnosis.querySelector("strong").textContent = "Fix plan ready for review";
    diagnosis.querySelector("p").textContent = "Update two call sites and one fixture, then generate a Vitest regression test.";
    diagnosis.querySelector(".analysis-badge").textContent = "94%";
  }, 1150);
});

tabs.forEach((tab) => tab.addEventListener("click", () => {
  tabs.forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-selected", "false"); });
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
}));
