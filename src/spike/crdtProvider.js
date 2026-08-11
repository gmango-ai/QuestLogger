// SPIKE ONLY — Yjs provider over a Supabase Realtime BROADCAST channel.
//
// Validates the "adopt Yjs over the channel we already have" hypothesis from
// docs/plans/whiteboard-crdt-local-first.md: instead of the hand-rolled `ops`
// events, we ship Yjs binary updates (as base64, since broadcast payloads are
// JSON) over the existing per-board channel, plus y-protocols awareness for
// cursors/presence. No new backend.
//
// Sync handshake (simplified for the spike): on subscribe each client (a) sends
// its state vector so peers reply with the updates it's missing, and (b) pushes
// its full state so peers merge it in. Idempotent — good enough for small docs;
// the real build fetches large initial state from the DB snapshot instead (see
// the plan's broadcast-payload-limit risk).
import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { supabase } from "../supabase";

// Uint8Array <-> base64 (broadcast carries JSON, not binary).
function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) u8[i] = s.charCodeAt(i);
  return u8;
}

export class SupabaseYjsProvider {
  constructor(doc, channelName, { awareness, onSynced, onChange } = {}) {
    this.doc = doc;
    this.awareness = awareness || new Awareness(doc);
    this.onSynced = onSynced;
    this.onChange = onChange;
    this.synced = false;
    this.metrics = { sent: 0, recv: 0, bytesSent: 0, bytesRecv: 0, peers: 1 };

    // Local doc update -> broadcast. Skip updates WE applied from the network
    // (origin === this) so we never echo.
    this._onUpdate = (update, origin) => {
      if (origin === this) return;
      this._send("update", toB64(update));
    };
    doc.on("update", this._onUpdate);

    // Local awareness change -> broadcast just the changed clients.
    this._onAwareness = ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed);
      this._send("awareness", toB64(encodeAwarenessUpdate(this.awareness, changed)));
      this._bump();
    };
    this.awareness.on("update", this._onAwareness);

    this.channel = supabase.channel(channelName, { config: { broadcast: { self: false } } });
    this.channel
      .on("broadcast", { event: "y" }, (m) => this._recv(m.payload))
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        this._send("sync1", toB64(Y.encodeStateVector(doc)));           // "here's what I have"
        this._send("update", toB64(Y.encodeStateAsUpdate(doc)));        // "here's my state, merge it"
        this._send("awareness", toB64(encodeAwarenessUpdate(this.awareness, [doc.clientID])));
      });
  }

  _send(kind, data) {
    this.metrics.sent += 1;
    this.metrics.bytesSent += data.length;
    try {
      this.channel.send({ type: "broadcast", event: "y", payload: { kind, data, from: this.doc.clientID } });
    } catch {
      /* transport hiccup — Yjs re-syncs on the next update */
    }
    this._bump();
  }

  _recv(p) {
    if (!p || p.from === this.doc.clientID) return;
    this.metrics.recv += 1;
    this.metrics.bytesRecv += p.data ? p.data.length : 0;
    try {
      if (p.kind === "update") {
        Y.applyUpdate(this.doc, fromB64(p.data), this); // origin=this => not re-broadcast
        if (!this.synced) { this.synced = true; this.onSynced?.(); }
      } else if (p.kind === "sync1") {
        // Peer told us its state vector -> send exactly the updates it's missing.
        this._send("update", toB64(Y.encodeStateAsUpdate(this.doc, fromB64(p.data))));
      } else if (p.kind === "awareness") {
        applyAwarenessUpdate(this.awareness, fromB64(p.data), this);
      }
    } catch {
      /* malformed / out-of-order — ignore; Yjs converges on the next update */
    }
    this._bump();
  }

  _bump() {
    this.metrics.peers = this.awareness.getStates().size;
    this.onChange?.(this.metrics);
  }

  destroy() {
    try { this.doc.off("update", this._onUpdate); } catch { /* */ }
    try { this.awareness.off("update", this._onAwareness); } catch { /* */ }
    try { removeAwarenessStates(this.awareness, [this.doc.clientID], this); } catch { /* */ }
    try { supabase.removeChannel(this.channel); } catch { /* */ }
  }
}
