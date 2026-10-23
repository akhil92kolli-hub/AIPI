// Companion process for live-supabase-authorization-acceptance.py.
// Credentials arrive as one JSON line on stdin and are never printed.
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const initial = await new Promise((resolve) => lines.once('line', resolve));
const { ref, anon, accessToken, workspaceId } = JSON.parse(initial);
const topic = `realtime:aipi-acceptance-${workspaceId}`;
const socket = new WebSocket(`wss://${ref}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anon)}&vsn=1.0.0`);
socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    topic,
    event: 'phx_join',
    payload: {
      access_token: accessToken,
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: '' },
        postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'team_change_events', filter: `workspace_id=eq.${workspaceId}` }],
      },
    },
    ref: '1',
    join_ref: '1',
  }));
});
socket.addEventListener('message', (raw) => {
  let message;
  try { message = JSON.parse(raw.data); } catch { return; }
  if (message.event === 'phx_reply' && message.ref === '1') {
    send({ type: message.payload?.status === 'ok' ? 'joined' : 'join_error' });
  } else if (message.event === 'postgres_changes') {
    send({ type: 'change', operationId: message.payload?.data?.record?.operation_id ?? null });
  } else if (message.event === 'system') {
    send({ type: 'system', status: message.payload?.status ?? null, extension: message.payload?.extension ?? null });
  } else if (message.event === 'phx_error' || message.event === 'phx_close') {
    send({ type: 'channel_error' });
  }
});
socket.addEventListener('error', () => send({ type: 'socket_error' }));
socket.addEventListener('close', () => process.exit(0));
lines.on('line', (line) => {
  if (line === 'close') socket.close();
});
