import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const name of ["0001_gateway", "0002_private_room_history", "0003_durable_link"]) {
      this.sqlite.exec(readFileSync(new URL("../../drizzle/" + name + ".sql", import.meta.url), "utf8"));
    }
  }
  prepare(sql) {
    const database = this.sqlite;
    const wrap = params => ({
      bind: (...values) => wrap(values),
      run() {
        const result = database.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      first(column) {
        const row = database.prepare(sql).get(...params);
        return row ? column === undefined ? row : row[column] : null;
      },
      all() { return { results: database.prepare(sql).all(...params) }; },
    });
    return wrap([]);
  }
  batch(statements) {
    this.sqlite.exec("BEGIN");
    try { const results = statements.map(statement => statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  close() { this.sqlite.close(); }
}

export function memoryRelay(clock = Date.now) {
  const rooms = new Map();
  function response(status, body) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  return async (input, init = {}) => {
    const url = new URL(input), method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.pathname === "/v1/rooms" && method === "POST") {
      const room = { expiresAt: new Date(clock() + 86400000).toISOString(), members: new Map([[body.participantId, { participantId: body.participantId, role: "owner" }]]), queues: new Map([[body.participantId, []]]) };
      rooms.set(body.roomId, room);
      return response(201, { created: true, protocolVersion: 2, expiresAt: room.expiresAt });
    }
    const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})(?:\/(join|status|messages|acks|leave))?$/.exec(url.pathname);
    const room = match && rooms.get(match[1]);
    if (!room) return response(404, {});
    const action = match[2];
    if (action === "status") return response(200, { protocolVersion: 2, expiresAt: room.expiresAt, participantCount: room.members.size, participants: [...room.members.values()] });
    if (action === "join") {
      room.members.set(body.participantId, { participantId: body.participantId, role: "member" }); room.queues.set(body.participantId, []);
      return response(200, { joined: true, protocolVersion: 2, expiresAt: room.expiresAt });
    }
    if (action === "messages" && method === "POST") {
      for (const [id, queue] of room.queues) if (id !== body.senderId && !queue.some(e => e.messageId === body.messageId)) queue.push(body);
      return response(202, { accepted: true });
    }
    if (action === "messages") return response(200, { messages: room.queues.get(url.searchParams.get("participantId")) ?? [] });
    if (action === "acks") {
      const queue = room.queues.get(body.participantId) ?? [];
      const remaining = queue.filter(e => !body.messageIds.includes(e.messageId)); room.queues.set(body.participantId, remaining);
      return response(200, { acknowledged: queue.length - remaining.length });
    }
    if (action === "leave") { room.members.delete(body.participantId); room.queues.delete(body.participantId); return response(200, { left: true }); }
    if (!action && method === "DELETE") { rooms.delete(match[1]); return response(200, { closed: true }); }
    return response(404, {});
  };
}
