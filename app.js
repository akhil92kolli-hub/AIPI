const sendButton = document.querySelector("#sendRequest");
const terminal = document.querySelector(".terminal-card");
const diagnosis = document.querySelector("#diagnosis");
const tabs = [...document.querySelectorAll(".terminal-tabs button")];

sendButton?.addEventListener("click", () => {
  if (terminal.classList.contains("loading")) return;
  terminal.classList.remove("success");
  terminal.classList.add("loading");
  sendButton.disabled = true;
  sendButton.firstChild.textContent = "Sending ";
  diagnosis.querySelector("strong").textContent = "AI-PI is reading the response";
  diagnosis.querySelector("p").textContent = "Checking status, schema, timing, and assertions…";
  diagnosis.querySelector(".analysis-badge").textContent = "···";

  window.setTimeout(() => {
    terminal.classList.remove("loading");
    terminal.classList.add("success");
    sendButton.disabled = false;
    sendButton.firstChild.textContent = "Send ";
    diagnosis.querySelector("strong").textContent = "AI-PI analysis";
    diagnosis.querySelector("p").textContent = "Contract matched. Order created and both assertions passed.";
    diagnosis.querySelector(".analysis-badge").textContent = "2/2";
  }, 1150);
});

tabs.forEach((tab) => tab.addEventListener("click", () => {
  tabs.forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-selected", "false"); });
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
}));
