import { PAIRING_MAX_MESSAGE_BYTES, PAIRING_PROTOCOL, pairingSubprotocol, validatePairingRequest } from "../core/pairing.mjs";

export function startPairingClient({ websocketUrl, secret, localUrl, localToken, onStatus = () => {} }) {
  let socket;
  let stopped = false;
  let retry = 250;
  let timer;

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(websocketUrl, [PAIRING_PROTOCOL, pairingSubprotocol("companion", secret)]);
    socket.addEventListener("open", () => { retry = 250; onStatus({ status: "online" }); });
    socket.addEventListener("message", async (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : await event.data.text();
        if (raw.length > PAIRING_MAX_MESSAGE_BYTES) throw new Error("Pairing message is too large");
        const request = validatePairingRequest(JSON.parse(raw));
        const response = await fetch(`${localUrl}${request.path}`, {
          method: request.method,
          headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
          body: request.body === undefined || ["GET", "HEAD"].includes(request.method) ? undefined : JSON.stringify(request.body),
        });
        let body;
        const text = await response.text();
        try { body = text ? JSON.parse(text) : null; } catch { body = { error: "Local companion returned a non-JSON response" }; }
        const message = JSON.stringify({ type: "response", id: request.id, status: response.status, body });
        if (message.length > PAIRING_MAX_MESSAGE_BYTES) throw new Error("Local companion response exceeds the pairing limit");
        socket.send(message);
      } catch (error) {
        const id = (() => { try { return JSON.parse(String(event.data)).id; } catch { return "invalid"; } })();
        socket.send(JSON.stringify({ type: "response", id, status: 400, body: { error: error.message } }));
      }
    });
    socket.addEventListener("close", () => {
      onStatus({ status: stopped ? "offline" : "reconnecting" });
      if (!stopped) { timer = setTimeout(connect, retry); retry = Math.min(5000, retry * 2); }
    });
    socket.addEventListener("error", () => socket.close());
  };
  connect();
  return {
    close() { stopped = true; clearTimeout(timer); socket?.close(1000, "AIPI pairing stopped"); },
    get status() { return socket?.readyState === WebSocket.OPEN ? "online" : stopped ? "offline" : "connecting"; },
  };
}
