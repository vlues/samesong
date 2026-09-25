// A song room over public Nostr relays. Events are "ephemeral" (kind 2xxxx):
// relays forward them live and never store them, so the room really does vanish.
// Plain WebSockets, so it works on VPNs and locked-down networks where WebRTC can't.
import { generateSecretKey, getPublicKey, finalizeEvent } from 'https://esm.run/nostr-tools@2.25.2/pure';
import { SimplePool } from 'https://esm.run/nostr-tools@2.25.2/pool';

const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band', 'wss://nostr.mom'];
const KIND = 21077;
const sk = generateSecretKey();
export const selfId = getPublicKey(sk);
const pool = new SimplePool();

export function joinRoom(appId, roomId) {
  const tag = `${appId}:${roomId}`, handlers = {};
  const sub = pool.subscribe(RELAYS, { kinds: [KIND], '#t': [tag], since: Math.floor(Date.now() / 1000) - 5 }, {
    onevent(ev) {
      if (ev.pubkey === selfId) return;
      try { const { type, data } = JSON.parse(ev.content); handlers[type]?.(data, ev.pubkey); } catch {}
    },
  });
  return {
    on: (type, fn) => { handlers[type] = fn; },
    send: (type, data) => pool.publish(RELAYS, finalizeEvent({ kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', tag]], content: JSON.stringify({ type, data }) }, sk)).forEach(p => p.catch(() => {})),
    leave: () => sub.close(),
  };
}
