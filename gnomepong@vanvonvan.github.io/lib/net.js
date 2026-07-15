// Direct-connect networking for GnomePong. Host-authoritative: one player
// hosts (binds a UDP port), the other joins by IP:port. LAN uses the LAN IP;
// internet uses a forwarded port / public IP — identical code path.
//
// Transport: UDP datagrams, one JSON object per datagram (no stream framing —
// each datagram already IS one message). Only Gio/GLib are used here so this
// module can be exercised headlessly with plain `gjs`.
//
// Why UDP: the gameplay traffic suits it. The host broadcasts a FULL state
// snapshot every tick, so a dropped/reordered packet is self-healing — the next
// tick overwrites everything. Client input is last-value-wins, likewise
// loss-tolerant. UDP also avoids TCP head-of-line blocking, where one lost
// packet would stall every newer snapshot behind it.
//
// What UDP does NOT give us for free, and we add here:
//   * Reliable handshake — the client resends `hello` on a timer until it gets
//     a `welcome`/`reject`; the host re-acks a repeated `hello` idempotently.
//   * Disconnect detection — TCP surfaced a closed socket; UDP has no such
//     signal, so each side declares the peer gone after LIVENESS_MS of silence.
//     During play the tick-rate state/input traffic keeps the link "warm".
//
// NOTE: the secret is sent in clear text — it gates uninvited joins, it is not
// cryptographic security. UDP additionally makes source-spoofing easy, so this
// remains strictly a "keep randoms out", not an authentication, mechanism.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_PORT = 7777;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Handshake / liveness tuning (all milliseconds).
const HELLO_INTERVAL_MS = 250;   // client re-sends `hello` this often until acked
const CONNECT_TIMEOUT_MS = 6000; // client gives up if no welcome/reject by now
const LIVENESS_CHECK_MS = 1000;  // how often each side checks for peer silence
const LIVENESS_MS = 4000;        // no datagram for this long => peer is gone

const encode = (obj) => encoder.encode(JSON.stringify(obj));

// Monotonic "now" in milliseconds. Immune to wall-clock jumps.
function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

// A stable string key for a UDP source address, so we can tell "same client"
// from "someone else" across datagrams.
function addrKey(a) {
    try {
        return `${a.get_address().to_string()}:${a.get_port()}`;
    } catch (_e) {
        return null;
    }
}

function makeUdpSocket() {
    const s = new Gio.Socket({
        family: Gio.SocketFamily.IPV4,
        type: Gio.SocketType.DATAGRAM,
        protocol: Gio.SocketProtocol.UDP,
    });
    s.init(null);
    s.set_blocking(false);
    return s;
}

// Resolve "host" (literal IPv4/IPv6 or a name) + port to a GSocketAddress.
function resolveAddress(host, port) {
    const literal = Gio.InetAddress.new_from_string(host);
    if (literal)
        return Gio.InetSocketAddress.new(literal, port);
    // Names are rare for direct-connect LAN play; a short blocking lookup is
    // acceptable here (the join UI is already a modal "Connecting…" screen).
    const list = Gio.Resolver.get_default().lookup_by_name(host, null);
    if (!list || list.length === 0)
        throw new Error(`cannot resolve ${host}`);
    return Gio.InetSocketAddress.new(list[0], port);
}

// Best-effort LAN IP the host can share. Opens a UDP socket "toward" a public
// address (no packets sent) and reads back which local interface would be
// used. Returns null if it can't be determined.
export function guessLocalIP() {
    try {
        const s = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM,
            Gio.SocketProtocol.UDP);
        const dest = Gio.InetSocketAddress.new_from_string('8.8.8.8', 53);
        s.connect(dest, null);
        const local = s.get_local_address();
        const ip = local.get_address().to_string();
        s.close();
        return ip && ip !== '0.0.0.0' ? ip : null;
    } catch (_e) {
        return null;
    }
}

// Parse "host:port" (port optional → DEFAULT_PORT). Returns {host, port} or
// null if there's no host part.
export function parseAddress(text) {
    const t = (text || '').trim();
    if (!t)
        return null;
    const idx = t.lastIndexOf(':');
    if (idx <= 0)
        return { host: t, port: DEFAULT_PORT };
    const host = t.slice(0, idx);
    const port = parseInt(t.slice(idx + 1), 10);
    return { host, port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT };
}

// Owns one bound UDP socket: an async readable-source that drains datagrams and
// hands each parsed JSON object to `onDatagram(obj, srcAddress)`, plus a
// fire-and-forget `send(obj, address)`. Shared by NetHost and NetClient.
class UdpChannel {
    constructor(socket, cancellable, onDatagram) {
        this._socket = socket;
        this._cancellable = cancellable;
        this._onDatagram = onDatagram;
        this._closed = false;
        this._source = socket.create_source(GLib.IOCondition.IN, cancellable);
        this._source.set_callback(() => this._onReadable());
        this._source.attach(null);
    }

    _onReadable() {
        if (this._closed)
            return GLib.SOURCE_REMOVE;
        // Drain every datagram currently queued; the socket is non-blocking, so
        // an empty queue surfaces as WOULD_BLOCK and ends the loop.
        for (;;) {
            let bytes, from;
            try {
                [bytes, from] = this._socket.receive_bytes_from(65536, 0, this._cancellable);
            } catch (e) {
                if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WOULD_BLOCK))
                    return GLib.SOURCE_CONTINUE;
                if (e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return GLib.SOURCE_REMOVE;
                // Transient (e.g. ICMP port-unreachable surfaced as an error on
                // a prior send): ignore and keep listening.
                return GLib.SOURCE_CONTINUE;
            }
            const data = bytes.get_data();
            if (data && data.length > 0) {
                let obj = null;
                try {
                    obj = JSON.parse(decoder.decode(data));
                } catch (_e) {
                    // Ignore malformed datagrams rather than dropping the link.
                }
                if (obj)
                    this._onDatagram(obj, from);
            }
            // A handler may have closed us (reject / bye / stop).
            if (this._closed)
                return GLib.SOURCE_REMOVE;
        }
    }

    send(obj, address) {
        if (this._closed || !address)
            return;
        try {
            this._socket.send_to(address, encode(obj), this._cancellable);
        } catch (_e) {
            // UDP sends are best-effort; a later datagram may still get through.
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
        try { this._socket.close(); } catch (_e) {}
    }
}

// Host: binds a port, accepts a single client (validated by secret), then
// relays game messages. handlers: { connected(), input(y), closed(reason), error(e) }
export class NetHost {
    constructor({ port = DEFAULT_PORT, secret = '', handlers = {} }) {
        this._port = port;
        this._secret = String(secret);
        this._handlers = handlers;
        this._cancellable = new Gio.Cancellable();
        this._channel = null;
        this._clientAddr = null;   // GSocketAddress of the joined client
        this._clientKey = null;    // addrKey(clientAddr)
        this._ready = false;       // secret accepted?
        this._lastRecv = 0;
        this._livenessId = 0;
    }

    // Binds the port. Throws (GLib.Error) if it's unavailable. A port of 0 picks
    // any free port (handy for tests); the chosen port is returned either way.
    start() {
        const socket = makeUdpSocket();
        const bindPort = this._port && this._port > 0 ? this._port : 0;
        socket.bind(Gio.InetSocketAddress.new_from_string('0.0.0.0', bindPort), true);
        this._port = socket.get_local_address().get_port();
        this._channel = new UdpChannel(socket, this._cancellable,
            (obj, from) => this._onDatagram(obj, from));
        return this._port;
    }

    _onDatagram(msg, from) {
        const key = addrKey(from);

        if (!this._ready) {
            if (msg.t === 'hello') {
                if (msg.secret === this._secret) {
                    this._clientAddr = from;
                    this._clientKey = key;
                    this._ready = true;
                    this._lastRecv = nowMs();
                    this._channel.send({ t: 'welcome', side: 'right' }, from);
                    this._startLiveness();
                    this._handlers.connected?.();
                } else {
                    this._channel.send({ t: 'reject', reason: 'Wrong secret' }, from);
                }
            }
            return;
        }

        // We already have a player. A hello from a *different* address is a
        // second would-be joiner — refuse it; one game at a time.
        if (key !== this._clientKey) {
            if (msg.t === 'hello')
                this._channel.send({ t: 'reject', reason: 'Host busy' }, from);
            return;
        }

        this._lastRecv = nowMs();
        if (msg.t === 'hello') {
            // Retransmitted hello (our welcome was lost). Re-ack idempotently.
            if (msg.secret === this._secret)
                this._channel.send({ t: 'welcome', side: 'right' }, from);
        } else if (msg.t === 'input' && typeof msg.y === 'number') {
            this._handlers.input?.(msg.y);
        } else if (msg.t === 'bye') {
            this._onClosed('peer left');
        }
    }

    _startLiveness() {
        if (this._livenessId)
            return;
        this._livenessId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIVENESS_CHECK_MS, () => {
            if (this._ready && nowMs() - this._lastRecv > LIVENESS_MS) {
                this._onClosed('peer timed out');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveness() {
        if (this._livenessId) {
            GLib.source_remove(this._livenessId);
            this._livenessId = 0;
        }
    }

    // Drop the current client but keep the socket bound so a new one can join
    // (mirrors the old TCP listener staying up after a peer disconnected).
    _onClosed(reason) {
        const wasReady = this._ready;
        this._ready = false;
        this._clientAddr = null;
        this._clientKey = null;
        this._stopLiveness();
        if (wasReady)
            this._handlers.closed?.(reason);
    }

    sendState(state) {
        if (this._ready && this._clientAddr)
            this._channel.send({ t: 'state', ...state }, this._clientAddr);
    }

    stop() {
        this._stopLiveness();
        // Best-effort goodbye before we cancel (send_to fails once cancelled).
        if (this._ready && this._clientAddr)
            this._channel?.send({ t: 'bye' }, this._clientAddr);
        this._cancellable.cancel();
        if (this._channel) {
            this._channel.close();
            this._channel = null;
        }
        this._clientAddr = null;
        this._clientKey = null;
        this._ready = false;
    }
}

// Client: resends the secret until welcomed/rejected, then streams input and
// receives state. handlers: { welcome(side), state(obj), rejected(reason), closed(reason), error(e) }
export class NetClient {
    constructor({ host, port = DEFAULT_PORT, secret = '', handlers = {} }) {
        this._host = host;
        this._port = port;
        this._secret = String(secret);
        this._handlers = handlers;
        this._cancellable = new Gio.Cancellable();
        this._channel = null;
        this._serverAddr = null;
        this._welcomed = false;
        this._done = false;         // welcomed | rejected | failed — stop hello resends
        this._closedFired = false;
        this._helloId = 0;
        this._deadlineId = 0;
        this._lastRecv = 0;
        this._livenessId = 0;
    }

    connect() {
        let socket;
        try {
            socket = makeUdpSocket();
            this._serverAddr = resolveAddress(this._host, this._port);
        } catch (e) {
            this._handlers.error?.(e);
            this._handlers.closed?.(e?.message || 'could not connect');
            return;
        }
        this._channel = new UdpChannel(socket, this._cancellable,
            (obj) => this._onDatagram(obj));

        // Fire the first hello now, then resend until welcomed/rejected. UDP has
        // no connect handshake, so this IS how we reach the host reliably.
        this._sendHello();
        this._helloId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HELLO_INTERVAL_MS, () => {
            if (this._done)
                return GLib.SOURCE_REMOVE;
            this._sendHello();
            return GLib.SOURCE_CONTINUE;
        });
        this._deadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONNECT_TIMEOUT_MS, () => {
            this._deadlineId = 0;
            if (!this._welcomed && !this._done)
                this._onClosed('no response from host');
            return GLib.SOURCE_REMOVE;
        });
    }

    get welcomed() { return this._welcomed; }

    _sendHello() {
        this._channel?.send({ t: 'hello', secret: this._secret }, this._serverAddr);
    }

    _onDatagram(msg) {
        this._lastRecv = nowMs();
        switch (msg.t) {
            case 'welcome':
                if (!this._welcomed && !this._done) {
                    this._welcomed = true;
                    this._done = true;
                    this._stopHello();
                    this._startLiveness();
                    this._handlers.welcome?.(msg.side || 'right');
                }
                break;
            case 'reject':
                if (!this._done) {
                    this._done = true;
                    this._stopHello();
                    this._handlers.rejected?.(msg.reason || 'rejected');
                    this.stop();
                }
                break;
            case 'state':
                this._handlers.state?.(msg);
                break;
            case 'bye':
                this._onClosed('host left');
                break;
        }
    }

    _startLiveness() {
        this._lastRecv = nowMs();
        if (this._livenessId)
            return;
        this._livenessId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIVENESS_CHECK_MS, () => {
            if (this._welcomed && nowMs() - this._lastRecv > LIVENESS_MS) {
                this._onClosed('host timed out');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopHello() {
        if (this._helloId) {
            GLib.source_remove(this._helloId);
            this._helloId = 0;
        }
        if (this._deadlineId) {
            GLib.source_remove(this._deadlineId);
            this._deadlineId = 0;
        }
    }

    _stopLiveness() {
        if (this._livenessId) {
            GLib.source_remove(this._livenessId);
            this._livenessId = 0;
        }
    }

    _onClosed(reason) {
        if (this._closedFired)
            return;
        this._closedFired = true;
        this._done = true;
        this._stopHello();
        this._stopLiveness();
        this._handlers.closed?.(reason);
    }

    sendInput(y) {
        if (this._welcomed && this._channel)
            this._channel.send({ t: 'input', y }, this._serverAddr);
    }

    stop() {
        this._done = true;
        this._stopHello();
        this._stopLiveness();
        if (this._welcomed && this._channel && this._serverAddr)
            this._channel.send({ t: 'bye' }, this._serverAddr);
        this._cancellable.cancel();
        if (this._channel) {
            this._channel.close();
            this._channel = null;
        }
    }
}
