// Direct-connect networking for GnomePong. Host-authoritative: one player
// hosts (listens on a port), the other joins by IP:port. LAN uses the LAN IP;
// internet uses a forwarded port / public IP — identical code path.
//
// Wire format: newline-delimited JSON, one message per line (JSON never
// contains a raw newline). Only Gio/GLib are used here so this module can be
// exercised headlessly with plain `gjs`.
//
// NOTE: the connection is plain TCP — the shared secret is sent in clear text.
// It gates uninvited joins; it is not cryptographic security.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_PORT = 7777;

const encoder = new TextEncoder();

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

// Wraps one accepted/established connection: ordered async writes + a
// line-reader loop. `handlers` = { message(obj), closed(reason), error(e) }.
class Peer {
    constructor(connection, cancellable, handlers) {
        this._conn = connection;
        this._cancellable = cancellable;
        this._handlers = handlers;
        this._out = connection.get_output_stream();
        this._in = new Gio.DataInputStream({
            base_stream: connection.get_input_stream(),
            close_base_stream: true,
        });
        this._in.set_newline_type(Gio.DataStreamNewlineType.LF);
        this._queue = [];
        this._writing = false;
        this._closed = false;
        this._readLoop();
    }

    send(obj) {
        if (this._closed)
            return;
        this._queue.push(encoder.encode(`${JSON.stringify(obj)}\n`));
        this._flush();
    }

    _flush() {
        if (this._writing || this._closed || this._queue.length === 0)
            return;
        this._writing = true;
        const bytes = new GLib.Bytes(this._queue.shift());
        this._out.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            try {
                const n = s.write_bytes_finish(res);
                if (n < bytes.get_size()) {
                    // Rare partial write — requeue the tail.
                    const rest = bytes.get_data().slice(n);
                    this._queue.unshift(rest);
                }
                this._writing = false;
                this._flush();
            } catch (e) {
                this._fail(e);
            }
        });
    }

    _readLoop() {
        this._in.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch (e) {
                this._fail(e);
                return;
            }
            if (line === null) {
                this.close('peer closed the connection');
                return;
            }
            if (line.length > 0) {
                let obj = null;
                try {
                    obj = JSON.parse(line);
                } catch (_e) {
                    // Ignore malformed frames rather than dropping the link.
                }
                if (obj && this._handlers.message)
                    this._handlers.message(obj);
            }
            if (!this._closed)
                this._readLoop();
        });
    }

    _fail(e) {
        if (this._closed)
            return;
        if (e && e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            this.close('cancelled');
            return;
        }
        if (this._handlers.error)
            this._handlers.error(e);
        this.close(e && e.message ? e.message : 'connection error');
    }

    close(reason) {
        if (this._closed)
            return;
        this._closed = true;
        try {
            this._conn.close(null);
        } catch (_e) {
            // ignore
        }
        if (this._handlers.closed)
            this._handlers.closed(reason);
    }
}

// Host: listens, accepts a single client, validates the secret, then relays
// game messages. handlers: { connected(), input(y), closed(reason), error(e) }
export class NetHost {
    constructor({ port = DEFAULT_PORT, secret = '', handlers = {} }) {
        this._port = port;
        this._secret = String(secret);
        this._handlers = handlers;
        this._cancellable = new Gio.Cancellable();
        this._service = null;
        this._peer = null;
        this._ready = false; // secret accepted?
    }

    // Begins listening. Throws (GLib.Error) if the port is unavailable.
    // A port of 0 picks any free port (handy for tests); the chosen port is
    // returned either way.
    start() {
        this._service = new Gio.SocketService();
        if (this._port && this._port > 0)
            this._service.add_inet_port(this._port, null);
        else
            this._port = this._service.add_any_inet_port(null);
        this._service.connect('incoming', (_service, connection) => {
            this._onIncoming(connection);
            return true; // handled
        });
        this._service.start();
        return this._port;
    }

    _onIncoming(connection) {
        if (this._peer) {
            // Already have a player — refuse extras.
            try { connection.close(null); } catch (_e) {}
            return;
        }
        this._peer = new Peer(connection, this._cancellable, {
            message: (msg) => this._onMessage(msg),
            closed: (reason) => this._onClosed(reason),
            error: (e) => this._handlers.error?.(e),
        });
    }

    _onMessage(msg) {
        if (!this._ready) {
            if (msg.t === 'hello') {
                if (msg.secret === this._secret) {
                    this._ready = true;
                    this._peer.send({ t: 'welcome', side: 'right' });
                    this._handlers.connected?.();
                } else {
                    this._peer.send({ t: 'reject', reason: 'Wrong secret' });
                    // Give the reject a moment to flush, then drop.
                    this._rejectAndDrop();
                }
            }
            return;
        }
        if (msg.t === 'input' && typeof msg.y === 'number')
            this._handlers.input?.(msg.y);
        else if (msg.t === 'bye')
            this._peer?.close('peer left');
    }

    _rejectAndDrop() {
        const peer = this._peer;
        this._peer = null;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            peer?.close('rejected');
            return GLib.SOURCE_REMOVE;
        });
    }

    _onClosed(reason) {
        this._peer = null;
        this._ready = false;
        this._handlers.closed?.(reason);
    }

    sendState(state) {
        if (this._ready && this._peer)
            this._peer.send({ t: 'state', ...state });
    }

    stop() {
        this._cancellable.cancel();
        if (this._peer) {
            try { this._peer.send({ t: 'bye' }); } catch (_e) {}
            this._peer.close('host stopped');
            this._peer = null;
        }
        if (this._service) {
            this._service.stop();
            this._service.close();
            this._service = null;
        }
    }
}

// Client: connects, sends the secret, then streams input and receives state.
// handlers: { welcome(side), state(obj), rejected(reason), closed(reason), error(e) }
export class NetClient {
    constructor({ host, port = DEFAULT_PORT, secret = '', handlers = {} }) {
        this._host = host;
        this._port = port;
        this._secret = String(secret);
        this._handlers = handlers;
        this._cancellable = new Gio.Cancellable();
        this._peer = null;
        this._welcomed = false;
    }

    connect() {
        const client = new Gio.SocketClient();
        client.connect_to_host_async(this._host, this._port, this._cancellable, (c, res) => {
            let connection;
            try {
                connection = c.connect_to_host_finish(res);
            } catch (e) {
                this._handlers.error?.(e);
                this._handlers.closed?.(e && e.message ? e.message : 'could not connect');
                return;
            }
            this._peer = new Peer(connection, this._cancellable, {
                message: (msg) => this._onMessage(msg),
                closed: (reason) => this._handlers.closed?.(reason),
                error: (e) => this._handlers.error?.(e),
            });
            this._peer.send({ t: 'hello', secret: this._secret });
        });
    }

    _onMessage(msg) {
        switch (msg.t) {
            case 'welcome':
                this._welcomed = true;
                this._handlers.welcome?.(msg.side || 'right');
                break;
            case 'reject':
                this._handlers.rejected?.(msg.reason || 'rejected');
                this._peer?.close(msg.reason || 'rejected');
                break;
            case 'state':
                this._handlers.state?.(msg);
                break;
            case 'bye':
                this._peer?.close('host left');
                break;
        }
    }

    sendInput(y) {
        if (this._welcomed && this._peer)
            this._peer.send({ t: 'input', y });
    }

    stop() {
        this._cancellable.cancel();
        if (this._peer) {
            try { this._peer.send({ t: 'bye' }); } catch (_e) {}
            this._peer.close('client stopped');
            this._peer = null;
        }
    }
}
