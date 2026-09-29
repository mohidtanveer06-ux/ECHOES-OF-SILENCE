"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_PLAYERS = 5;
const MAX_ROOMS = 250;
const MAX_MESSAGE_BYTES = 32 * 1024;
const ROOM_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const rooms = new Map();

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }
  if (request.method !== "GET" || (pathname !== "/" && pathname !== "/index.html")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(path.join(__dirname, "index.html"), (error, content) => {
    if (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("Game page could not be loaded.");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin"
    });
    response.end(content);
  });
});

const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false
});

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket, code, message) {
  send(socket, { type: "error", code, message });
}

function validName(value) {
  return typeof value === "string" && cleanName(value).length > 0 && cleanName(value).length <= 16;
}

function cleanName(value) {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 16);
}

function roster(room) {
  return [...room.players.values()].map(({ id, name }) => ({ id, name }));
}

function broadcast(room, message, exceptId = "") {
  for (const player of room.players.values()) {
    if (player.id !== exceptId) send(player.socket, message);
  }
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let code = "";
    for (let index = 0; index < 5; index += 1) {
      code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not allocate a room code.");
}

function detachPlayer(player, reason = "left") {
  const room = player.room;
  if (!room || !rooms.has(room.code)) return;
  player.room = null;

  if (room.hostId === player.id) {
    rooms.delete(room.code);
    for (const member of room.players.values()) {
      member.room = null;
      if (member.socket !== player.socket) send(member.socket, { type: "roomClosed", reason: "host-left" });
    }
    room.players.clear();
    return;
  }

  room.players.delete(player.id);
  if (room.snapshot) {
    room.snapshot = {
      ...room.snapshot,
      players: room.snapshot.players.filter((member) => member.id !== player.id)
    };
  }
  broadcast(room, { type: "playerLeft", playerId: player.id, name: player.name, reason, players: roster(room) });
  if (room.snapshot) broadcast(room, { type: "snapshot", snapshot: room.snapshot });
  if (room.players.size === 0) rooms.delete(room.code);
}

function handleRoomMessage(player, message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    sendError(player.socket, "BAD_MESSAGE", "Invalid message.");
    return;
  }

  if (message.type === "create") {
    if (player.room) return sendError(player.socket, "IN_ROOM", "Leave your current room first.");
    if (!validName(message.name)) return sendError(player.socket, "BAD_NAME", "Choose a name from 1 to 16 characters.");
    if (rooms.size >= MAX_ROOMS) return sendError(player.socket, "SERVER_BUSY", "There are too many active rooms. Try again shortly.");

    let code;
    try {
      code = generateRoomCode();
    } catch (error) {
      console.error("Room allocation failed:", error);
      return sendError(player.socket, "SERVER_BUSY", "Could not create a room right now.");
    }
    const room = { code, hostId: player.id, players: new Map(), snapshot: null };
    player.name = cleanName(message.name);
    player.room = room;
    room.players.set(player.id, player);
    rooms.set(code, room);
    send(player.socket, { type: "created", roomCode: code, playerId: player.id, hostId: player.id, players: roster(room) });
    return;
  }

  if (message.type === "join") {
    if (player.room) return sendError(player.socket, "IN_ROOM", "Leave your current room first.");
    if (typeof message.roomCode !== "string" || !/^[A-Z0-9]{5}$/.test(message.roomCode.toUpperCase())) {
      return sendError(player.socket, "BAD_CODE", "Enter a valid 5-character room code.");
    }
    if (!validName(message.name)) return sendError(player.socket, "BAD_NAME", "Choose a name from 1 to 16 characters.");
    const room = rooms.get(message.roomCode.toUpperCase());
    if (!room) return sendError(player.socket, "ROOM_NOT_FOUND", "Room not found. Check the code and try again.");
    if (room.players.size >= MAX_PLAYERS) return sendError(player.socket, "ROOM_FULL", "This room already has five players.");

    player.name = cleanName(message.name);
    player.room = room;
    room.players.set(player.id, player);
    send(player.socket, {
      type: "joined",
      roomCode: room.code,
      playerId: player.id,
      hostId: room.hostId,
      gameState: room.snapshot?.gameState || "lobby",
      players: roster(room),
      snapshot: room.snapshot
    });
    broadcast(room, { type: "playerJoined", player: { id: player.id, name: player.name }, players: roster(room), hostId: room.hostId }, player.id);
    return;
  }

  const room = player.room;
  if (!room) return sendError(player.socket, "NOT_IN_ROOM", "Join or create a room first.");

  if (message.type === "snapshot") {
    if (room.hostId !== player.id) return sendError(player.socket, "HOST_ONLY", "Only the room host can publish game state.");
    const snapshot = message.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        !Array.isArray(snapshot.maze) || snapshot.maze.length !== 15 ||
        snapshot.maze.some((row) => !Array.isArray(row) || row.length !== 21 || row.some((cell) => cell !== "." && cell !== "#")) ||
        !Array.isArray(snapshot.players) || !Array.isArray(snapshot.enemies) ||
        !Number.isInteger(snapshot.level) || snapshot.level < 1 || snapshot.level > 5 ||
        !Number.isInteger(snapshot.lives) || snapshot.lives < 0 || snapshot.lives > 2 ||
        !["lobby", "playing", "won", "lost"].includes(snapshot.gameState)) {
      return sendError(player.socket, "BAD_SNAPSHOT", "Invalid game state.");
    }
    const rosterById = new Map(roster(room).map((member) => [member.id, member]));
    const reportedPlayers = new Map(snapshot.players
      .filter((item) => item && rosterById.has(item.id) && Number.isFinite(item.x) && Number.isFinite(item.y))
      .map((item) => [item.id, item]));
    const occupied = new Set();
    const openCells = [];
    for (let y = 1; y < snapshot.maze.length - 1; y += 1) {
      for (let x = 1; x < snapshot.maze[y].length - 1; x += 1) {
        if (snapshot.maze[y][x] === ".") openCells.push({ x, y, distance: Math.abs(x - 1) + Math.abs(y - 1) });
      }
    }
    openCells.sort((first, second) => first.distance - second.distance);
    const players = roster(room).map((member, index) => {
      const reported = reportedPlayers.get(member.id);
      let position;
      if (reported) {
        position = {
          x: Math.max(7, Math.min(581, reported.x)),
          y: Math.max(7, Math.min(413, reported.y))
        };
      } else {
        position = null;
        for (const cell of openCells) {
          const key = `${cell.x},${cell.y}`;
          if (!occupied.has(key)) {
            occupied.add(key);
            position = { x: (cell.x + .5) * 28, y: (cell.y + .5) * 28 };
            break;
          }
        }
        position ||= { x: 42 + index * 8, y: 42 };
      }
      const cell = `${Math.floor(position.x / 28)},${Math.floor(position.y / 28)}`;
      occupied.add(cell);
      return {
        id: member.id,
        name: member.name,
        x: position.x,
        y: position.y,
        radius: 7,
        escaped: reported?.escaped === true,
        safe: Number.isFinite(reported?.safe) ? Math.max(0, Math.min(3, reported.safe)) : 1.4,
        keys: {},
        panic: reported?.panic === true
      };
    });
    const enemies = snapshot.enemies.slice(0, 20)
      .filter((enemy) => enemy && Number.isFinite(enemy.x) && Number.isFinite(enemy.y))
      .map((enemy, index) => ({
        x: Math.max(0, Math.min(588, enemy.x)),
        y: Math.max(0, Math.min(420, enemy.y)),
        id: index,
        alerted: Number.isFinite(enemy.alerted) ? Math.max(0, Math.min(10, enemy.alerted)) : 0
      }));
    const ripples = Array.isArray(snapshot.ripples) ? snapshot.ripples.slice(-150) : [];
    room.snapshot = { ...snapshot, hostId: room.hostId, players, enemies, ripples };
    broadcast(room, { type: "snapshot", snapshot: room.snapshot }, player.id);
    return;
  }

  if (message.type === "input") {
    if (player.id === room.hostId) return;
    const input = {};
    if (typeof message.key === "string" &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d"].includes(message.key) &&
        typeof message.down === "boolean") {
      input.key = message.key;
      input.down = message.down;
    }
    if (typeof message.panic === "boolean") input.panic = message.panic;
    if (message.noise === true) input.noise = true;
    if (!Object.keys(input).length) return;
    const host = room.players.get(room.hostId);
    if (host) send(host.socket, { type: "input", playerId: player.id, ...input });
    return;
  }

  if (message.type === "leave") {
    detachPlayer(player, "left");
    send(player.socket, { type: "left" });
    return;
  }

  sendError(player.socket, "UNKNOWN_MESSAGE", "Unsupported room message.");
}

server.on("upgrade", (request, socket, head) => {
  let pathname;
  let originHost;
  try {
    pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    originHost = request.headers.origin ? new URL(request.headers.origin).host : "";
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== "/ws" || (originHost && originHost !== request.headers.host)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket);
  });
});

webSockets.on("connection", (socket) => {
  const player = { id: crypto.randomUUID(), name: "", room: null, socket, messageWindow: Date.now(), messageCount: 0 };
  send(socket, { type: "connected", playerId: player.id });

  socket.on("message", (buffer) => {
    const now = Date.now();
    if (now - player.messageWindow >= 1000) {
      player.messageWindow = now;
      player.messageCount = 0;
    }
    player.messageCount += 1;
    if (player.messageCount > 100) {
      socket.close(1008, "Rate limit exceeded");
      return;
    }

    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch {
      sendError(socket, "BAD_JSON", "Message must be valid JSON.");
      return;
    }
    handleRoomMessage(player, message);
  });

  socket.on("close", () => detachPlayer(player, "disconnected"));
  socket.on("error", (error) => console.warn("WebSocket client error:", error.message));
});

const heartbeat = setInterval(() => {
  for (const socket of webSockets.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

webSockets.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
});

server.listen(PORT, HOST, () => {
  console.log(`Echoes of Silence server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) {
    broadcast(room, { type: "roomClosed", reason: "server-shutdown" });
  }
  webSockets.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
