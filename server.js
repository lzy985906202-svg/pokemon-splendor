"use strict";
// =============================
// v0.9.3 Render 公网部署适配
// Express + Socket.IO + 权威状态管理
// 兼容本地开发、局域网联机与 Render 公网部署
// =============================
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Server } = require("socket.io");

// 端口必须在顶部声明（路由中会引用 PORT）
const PORT = parseInt(process.env.PORT, 10) || 3000;

// 复用 game.js 纯逻辑函数（game.js 顶部有 Node.js 环境兼容层）
const rules = require("./game.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  cors: {
    origin: true,
    credentials: true
  }
});

// =============================
// 健康检查（Render 部署用）
// =============================
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    status: "running",
    version: VERSION,
    rooms: rooms.size,
    time: Date.now()
  });
});

// 静态资源诊断接口
app.get("/health/assets", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const checks = {
    onlineJs: fs.existsSync(path.join(__dirname, "online.js")),
    gameJs: fs.existsSync(path.join(__dirname, "game.js")),
    bgmJs: fs.existsSync(path.join(__dirname, "bgm.js")),
    styleCss: fs.existsSync(path.join(__dirname, "style.css")),
    cardsJson: fs.existsSync(path.join(__dirname, "cards.json"))
  };
  let socketClient = false;
  try {
    const pkgRoot = path.dirname(require.resolve("socket.io/package.json"));
    socketClient = fs.existsSync(path.join(pkgRoot, "client-dist", "socket.io.js"));
  } catch (e) {
    socketClient = false;
  }
  res.json({ ok: true, assets: checks, socketIoClient: socketClient });
});

// =============================
// 显式静态路由（确保 Render 上 /online.js /game.js 不被 404）
// =============================
app.get("/online.js", (req, res) => {
  const filePath = path.join(__dirname, "online.js");
  if (!fs.existsSync(filePath)) {
    console.error("[静态资源] online.js 不存在:", filePath);
    return res.status(404).send("online.js not found");
  }
  res.type("application/javascript");
  res.sendFile(filePath);
});

app.get("/game.js", (req, res) => {
  const filePath = path.join(__dirname, "game.js");
  if (!fs.existsSync(filePath)) {
    console.error("[静态资源] game.js 不存在:", filePath);
    return res.status(404).send("game.js not found");
  }
  res.type("application/javascript");
  res.sendFile(filePath);
});

// v0.9.6: bgm.js 背景音乐合成引擎（显式路由，防 Render 公网 404）
app.get("/bgm.js", (req, res) => {
  const filePath = path.join(__dirname, "bgm.js");
  if (!fs.existsSync(filePath)) {
    console.error("[静态资源] bgm.js 不存在:", filePath);
    return res.status(404).send("bgm.js not found");
  }
  res.type("application/javascript");
  res.sendFile(filePath);
});

// Socket.IO 客户端 fallback（serveClient=true 通常已自动处理，
// 此路由仅作为兜底，确保 /socket.io/socket.io.js 一定返回 JS）
app.get("/socket.io/socket.io.js", (req, res, next) => {
  // 排除 Engine.IO 协议请求（带 EIO 参数的走 socket.io 原生处理）
  if (req.query && req.query.EIO) {
    return next();
  }
  let clientPath = null;
  try {
    const pkgRoot = path.dirname(require.resolve("socket.io/package.json"));
    const candidate = path.join(pkgRoot, "client-dist", "socket.io.js");
    if (fs.existsSync(candidate)) {
      clientPath = candidate;
    }
  } catch (e) {
    // 找不到包路径，交给下一个中间件
  }
  if (!clientPath) return next();
  res.type("application/javascript");
  res.sendFile(clientPath);
});

// 静态文件服务
// v0.9.4: /assets 单独配置 7 天缓存（图片资源不变，可长期缓存）
app.use(
  "/assets",
  express.static(path.join(__dirname, "assets"), {
    maxAge: "7d",
    etag: true,
    lastModified: true
  })
);
// 其他静态文件（index.html / game.js / online.js 等）不设置长缓存
app.use(express.static(__dirname));

// =============================
// 局域网 IP 查询（供房主显示加入地址）
// =============================
function getLanIPv4List() {
  const result = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((iface) => {
      if (iface.family === "IPv4" && !iface.internal) {
        result.push({ name, address: iface.address });
      }
    });
  });
  return result;
}

app.get("/api/lan-info", (req, res) => {
  res.json({
    port: PORT,
    addresses: getLanIPv4List(),
    hint: "请在命令行输入 ipconfig 查看 IPv4 地址。"
  });
});

// =============================
// 房间管理
// =============================
const rooms = new Map();
// v0.9.11: socketId -> { roomCode, seatIndex } 反向映射，避免每次遍历 rooms 查 member
const socketToMember = new Map();
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混字符
const ROOM_CODE_LENGTH = 4;
const ROOM_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 小时无人操作过期
const VERSION = "0.9.12";

function generatePlayerToken() {
  // 稳定、随机、不可预测的玩家身份凭证（刷新后不变）
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Node < 19 兜底（engines.node >=20 实际不会走）
  return "tok_" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8);
}

function generateRoomCode() {
  let code;
  let tries = 0;
  do {
    code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    tries++;
  } while (rooms.has(code) && tries < 1000);
  return code;
}

function bindSocketMember(socketId, roomCode, seatIndex) {
  socketToMember.set(socketId, { roomCode, seatIndex });
}
function unbindSocketMember(socketId) {
  socketToMember.delete(socketId);
}
function getMemberBySocket(socketId) {
  const ref = socketToMember.get(socketId);
  if (!ref) return null;
  const room = rooms.get(ref.roomCode);
  if (!room) return null;
  const seat = room.players[ref.seatIndex];
  return seat ? { room, seat, seatIndex: ref.seatIndex } : null;
}
function findMemberByToken(room, playerToken) {
  if (!room || !playerToken) return -1;
  return room.players.findIndex((p) => p && !p.isAI && p.playerToken === playerToken);
}

function createRoom(hostSocketId, { playerName, playerCount, aiCount }) {
  const roomCode = generateRoomCode();
  const pc = Math.min(4, Math.max(2, Number(playerCount) || 2));
  const ac = Math.min(pc, Math.max(0, Number(aiCount) || 0));
  const hostToken = generatePlayerToken();

  const room = {
    roomCode,
    // v0.9.11: 房主身份绑定 seatIndex，不再依赖 socketId（刷新后 socketId 会变）
    // hostSeatIndex 指向一个稳定座位；isHost 是 seat 的标记字段
    hostSeatIndex: 0,
    playerCount: pc,
    aiCount: ac,
    players: [],
    spectators: [],
    gameState: null,
    status: "waiting",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  // 初始化座位
  for (let i = 0; i < pc; i++) {
    room.players.push({
      playerToken: null,  // v0.9.11: 稳定身份凭证（人类玩家才有）
      socketId: null,
      name: "",
      seatIndex: i,
      connected: false,
      isAI: false,
      isHost: i === 0   // v0.9.11: 房主身份写入 seat 本身，不依赖 socketId
    });
  }

  // AI 占座（从末尾开始）
  for (let i = pc - 1; i >= pc - ac; i--) {
    room.players[i].isAI = true;
    room.players[i].name = `AI ${i + 1}`;
    room.players[i].connected = true;
  }

  // 房主入座（seat 0）
  room.players[0].playerToken = hostToken;
  room.players[0].socketId = hostSocketId;
  room.players[0].name = playerName || "玩家 1";
  room.players[0].connected = true;
  bindSocketMember(hostSocketId, roomCode, 0);

  rooms.set(roomCode, room);
  return { room, hostToken };
}

function findRoomBySocket(socketId) {
  for (const [code, room] of rooms) {
    if (room.players.some((p) => p.socketId === socketId) || room.spectators.includes(socketId)) {
      return room;
    }
  }
  return null;
}

function sanitizeRoomForClient(room) {
  return {
    roomCode: room.roomCode,
    playerCount: room.playerCount,
    aiCount: room.aiCount,
    status: room.status,
    players: room.players.map((p) => ({
      name: p.name,
      seatIndex: p.seatIndex,
      connected: p.connected,
      isAI: p.isAI,
      // v0.9.11: 广播房主身份，客户端据此显示"房主"标签和开始游戏按钮权限
      isHost: Boolean(p.isHost)
    })),
    // v0.9.11: 房主 seat 索引（从稳定 seat 读取，不依赖 hostSocketId）
    hostSeatIndex: Number.isInteger(room.hostSeatIndex) ? room.hostSeatIndex : room.players.findIndex((p) => p.isHost)
  };
}

function broadcastRoomUpdate(room) {
  const data = sanitizeRoomForClient(room);
  room.players.forEach((p) => {
    if (p.socketId) io.to(p.socketId).emit("roomUpdated", { room: data });
  });
  room.spectators.forEach((sid) => {
    io.to(sid).emit("roomUpdated", { room: data });
  });
}

// v0.9.11: 统一的 decks 安全化（deck 保留长度、清空元素）
function buildSafeGameState(gameState) {
  if (!gameState) return gameState;
  const originalDecks = gameState.decks || {};
  const safeDecks = {};
  for (const key of Object.keys(originalDecks)) {
    const arr = Array.isArray(originalDecks[key]) ? originalDecks[key] : [];
    safeDecks[key] = new Array(arr.length);
  }
  return { ...gameState, decks: safeDecks };
}

function broadcastState(room) {
  if (!room.gameState) return;
  const safeState = buildSafeGameState(room.gameState);
  room.players.forEach((p) => {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit("stateUpdated", { roomCode: room.roomCode, gameState: safeState });
    }
  });
  room.spectators.forEach((sid) => {
    io.to(sid).emit("stateUpdated", { roomCode: room.roomCode, gameState: safeState });
  });
}

// =============================
// 卡牌数据加载
// =============================
let cardDatabase = [];
function loadCardDatabase() {
  const paths = ["cards.json", "data/cards.json"];
  for (const p of paths) {
    try {
      const raw = fs.readFileSync(path.join(__dirname, p), "utf-8");
      const data = JSON.parse(raw);
      // cards.json 可能是数组，也可能是 { cards: [...] } 结构；用 normalizeCardList 兼容
      const cards = rules.normalizeCardList(data);
      cardDatabase = cards.map((card, index) => rules.normalizeCard(card, index));
      console.log(`已加载 ${cardDatabase.length} 张卡牌：${p}`);
      return;
    } catch (e) {
      // 继续尝试下一个路径
    }
  }
  console.warn("警告：未能加载 cards.json，请确保文件存在。");
}
loadCardDatabase();

// =============================
// 开始联机游戏（服务器构建权威状态）
// =============================
function startOnlineGame(room) {
  const pc = room.playerCount;
  const state = rules.createEmptyGameState(pc);
  state.decks = rules.buildDecks(cardDatabase);

  // 填充公共区
  const MARKET_KEYS = rules.MARKET_KEYS || ["level3", "level2", "level1", "rare", "legend"];
  MARKET_KEYS.forEach((key) => {
    while (state.market[key].length < marketSize(key)) {
      if (!state.decks[key] || state.decks[key].length === 0) break;
      state.market[key].push(state.decks[key].pop());
    }
  });

  // 设置玩家名称和 AI 标志
  for (let i = 0; i < pc; i++) {
    const seat = room.players[i];
    state.players[i].name = seat.name || `玩家 ${i + 1}`;
    state.players[i].isAI = Boolean(seat.isAI);
  }

  state.onlineMode = true;
  state.roomId = room.roomCode;
  state.aiType = "mcts";
  state.spectatorMode = false;

  room.gameState = state;
  room.status = "playing";
  room.updatedAt = Date.now();
}

function marketSize(key) {
  const sizes = { level1: 4, level2: 4, level3: 4, rare: 2, legend: 2 };
  return sizes[key] || 0;
}

// =============================
// AI 回合处理（服务器侧）
// =============================
function maybeRunServerAI(room) {
  if (!room.gameState || room.gameState.gameOver) return;
  const gs = room.gameState;
  if (gs.phase !== "awaitAction") return;
  const player = gs.players[gs.currentPlayerIndex];
  if (!player || !player.isAI) return;

  // 用 MCTS 选择动作
  let action = null;
  try {
    action = rules.chooseActionByMCTS(gs.currentPlayerIndex);
  } catch (e) {
    // 降级：选合法动作
    const legalActions = rules.generateLegalActions(gs.currentPlayerIndex, gs);
    if (legalActions.length > 0) {
      action = legalActions[0];
    }
  }

  if (!action) {
    // 无合法动作，跳过回合
    rules.finishOnlineTurn(gs, gs.currentPlayerIndex);
    room.updatedAt = Date.now();
    return;
  }

  const result = rules.applyOnlineActionToState(gs, gs.currentPlayerIndex, action);
  if (result.ok && result.state) {
    room.gameState = result.state;
    room.updatedAt = Date.now();
  }
}

function runAllAITurns(room) {
  let safety = 20; // 防止无限循环
  while (safety-- > 0 && room.gameState && !room.gameState.gameOver) {
    const player = room.gameState.players[room.gameState.currentPlayerIndex];
    if (!player || !player.isAI) break;
    if (room.gameState.phase !== "awaitAction") break;
    maybeRunServerAI(room);
  }
}

// =============================
// Socket.IO 事件处理
// =============================
// P1-4 修复：双击重复提交防护。key=socket.id，ack 返回前拒绝同一 socket 的第二次 playerAction
const inFlightActions = new Set();

io.on("connection", (socket) => {
  console.log(`[连接] ${socket.id} v${VERSION}`);

  // 健康/版本（快速诊断）
  app.get("/health/version", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, version: VERSION, rooms: rooms.size, time: Date.now() });
  });
  if (!app._versionRoute) {
    app.get("/version", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, version: VERSION });
    });
    app._versionRoute = true;
  }

  // ========== 创建房间 ==========
  socket.on("createRoom", (payload, ack) => {
    try {
      const { playerName, playerCount, aiCount } = payload || {};
      const { room, hostToken } = createRoom(socket.id, { playerName, playerCount, aiCount });
      socket.join(room.roomCode);
      console.log(`[创建房间] ${room.roomCode} by ${playerName} (token=${hostToken.slice(0,8)}...)`);
      if (ack) ack({
        ok: true,
        roomCode: room.roomCode,
        seatIndex: 0,
        isHost: true,
        playerToken: hostToken,          // v0.9.11: 客户端存此 token 用于 resume
        playerName: room.players[0].name,
        room: sanitizeRoomForClient(room),
        gameStarted: room.status === "playing",
        gameState: room.gameState || undefined
      });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // ========== v0.9.11: 刷新/断线后 RESUME（唯一权威协议）==========
  // 客户端提供 roomCode + playerToken，服务器找回旧 member
  // 绝不使用 playerName 作为权威身份
  socket.on("resumeRoom", (payload, ack) => {
    try {
      const { roomCode, playerToken } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "ROOM_NOT_FOUND", code: "ROOM_NOT_FOUND" });
        return;
      }
      const seatIndex = findMemberByToken(room, playerToken);
      if (seatIndex < 0) {
        if (ack) ack({ ok: false, error: "INVALID_PLAYER_TOKEN", code: "INVALID_PLAYER_TOKEN" });
        return;
      }
      const seat = room.players[seatIndex];
      // 如果旧 socket 仍绑定，解绑旧 socket（防止旧 socket 继续控制该 seat）
      if (seat.socketId && seat.socketId !== socket.id) {
        try { unbindSocketMember(seat.socketId); } catch (e) { /* noop */ }
        try { io.sockets.sockets.get(seat.socketId)?.disconnect(true); } catch (e) { /* noop */ }
      }
      seat.socketId = socket.id;
      seat.connected = true;
      bindSocketMember(socket.id, room.roomCode, seatIndex);
      socket.join(room.roomCode);
      room.updatedAt = Date.now();
      broadcastRoomUpdate(room);
      const safeState = room.gameState ? buildSafeGameState(room.gameState) : undefined;
      console.log(`[resume] token=${(playerToken||"").slice(0,8)}... → ${room.roomCode} seat=${seatIndex} host=${seat.isHost} status=${room.status}`);
      if (ack) ack({
        ok: true,
        roomCode: room.roomCode,
        seatIndex,
        isHost: Boolean(seat.isHost),
        playerToken,
        playerName: seat.name,
        room: sanitizeRoomForClient(room),
        gameStarted: room.status === "playing",
        gameState: safeState
      });
      // 通知其他玩家：该玩家重连
      room.players.forEach((p) => {
        if (p.socketId && p.connected && p.socketId !== socket.id) {
          io.to(p.socketId).emit("playerReconnected", { seatIndex, name: seat.name });
        }
      });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // ========== 加入房间（仅用于首次加入；刷新后必须走 resumeRoom + playerToken）==========
  socket.on("joinRoom", (payload, ack) => {
    try {
      const { roomCode, playerName } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "房间不存在，请检查房间号。" });
        return;
      }

      // v0.9.11: 如果服务器端还在游戏中（状态 playing）且该玩家提供了 token 匹配 → 改用 resumeRoom 流程（不通过 joinRoom）
      // 这里 joinRoom 只处理：
      //   (a) waiting 状态下的新玩家入空位
      //   (b) 兼容：waiting 状态下断线玩家 token 重连（已在 resumeRoom 处理，这里仅兜底同名）
      //   (c) playing 状态：不允许新玩家进入（兼容旧客户端走 token 也 OK，直接走 resumeRoom 才推荐）

      let seatIndex = -1;
      let isRejoin = false;
      let playerToken = null;

      if (room.status === "playing") {
        // 游戏已开始：只接受 resumeRoom（playerToken）重连，joinRoom 直接拒绝
        if (ack) ack({ ok: false, error: "游戏进行中，请使用 playerToken 重连（请刷新页面自动恢复）。", code: "GAME_STARTED_USE_RESUME" });
        return;
      }

      // waiting 状态：先看是否有 token 对应的断线 seat（兼容旧流程）
      // 再看是否有空位填入新玩家；再兜底（同名）
      const emptySeat = rules.findEmptySeat(room.players);
      if (emptySeat < 0) {
        if (ack) ack({ ok: false, error: "房间已满，无法作为玩家加入。" });
        return;
      }
      seatIndex = emptySeat;
      playerToken = generatePlayerToken();
      room.players[seatIndex].playerToken = playerToken;
      room.players[seatIndex].socketId = socket.id;
      room.players[seatIndex].name = playerName || `玩家 ${seatIndex + 1}`;
      room.players[seatIndex].connected = true;
      bindSocketMember(socket.id, room.roomCode, seatIndex);
      console.log(`[加入房间] ${room.players[seatIndex].name} → ${room.roomCode} seat=${seatIndex} token=${playerToken.slice(0,8)}...`);

      socket.join(room.roomCode);
      room.updatedAt = Date.now();
      broadcastRoomUpdate(room);
      if (ack) ack({
        ok: true,
        roomCode: room.roomCode,
        seatIndex,
        isHost: Boolean(room.players[seatIndex].isHost),
        playerToken,
        playerName: room.players[seatIndex].name,
        room: sanitizeRoomForClient(room),
        gameStarted: room.status === "playing",
        gameState: room.gameState ? buildSafeGameState(room.gameState) : undefined
      });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // ========== 开始游戏（仅房主）==========
  socket.on("startOnlineGame", (payload, ack) => {
    try {
      const { roomCode } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "房间不存在，请检查房间号。" });
        return;
      }
      // v0.9.11: 房主身份由稳定 seat.isHost / socketToMember 决定，不再比对 socket.id == hostSocketId
      const member = getMemberBySocket(socket.id);
      if (!member || member.room.roomCode !== room.roomCode) {
        if (ack) ack({ ok: false, error: "你不属于此房间。" });
        return;
      }
      if (!member.seat.isHost) {
        if (ack) ack({ ok: false, error: "只有房主可以开始游戏。" });
        return;
      }
      if (room.status !== "waiting") {
        if (ack) ack({ ok: false, error: "游戏已开始" });
        return;
      }

      startOnlineGame(room);
      broadcastRoomUpdate(room);
      // 首次下发时用 buildSafeGameState 安全化
      const safe = buildSafeGameState(room.gameState);
      room.players.forEach((p) => {
        if (p.socketId && p.connected) {
          io.to(p.socketId).emit("stateUpdated", { roomCode: room.roomCode, gameState: safe });
        }
      });
      room.spectators.forEach((sid) => {
        io.to(sid).emit("stateUpdated", { roomCode: room.roomCode, gameState: safe });
      });

      // 如果当前玩家是 AI，自动执行
      setTimeout(() => {
        runAllAITurns(room);
        if (room.gameState) {
          const safe2 = buildSafeGameState(room.gameState);
          room.players.forEach((p) => {
            if (p.socketId && p.connected) io.to(p.socketId).emit("stateUpdated", { roomCode: room.roomCode, gameState: safe2 });
          });
        }
      }, 100);

      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // ========== 玩家行动（权威身份：socket → member）==========
  socket.on("playerAction", (payload, ack) => {
    if (inFlightActions.has(socket.id)) {
      if (ack) ack({ ok: false, error: "上一个动作正在处理中，请稍候。" });
      return;
    }
    inFlightActions.add(socket.id);
    try {
      const { roomCode, action } = payload || {};
      // v0.9.11: 绝对不信任客户端传来的 seatIndex / playerIndex
      // 身份唯一由 socket.id → socketToMember 反向映射决定
      const member = getMemberBySocket(socket.id);
      if (!member) {
        if (ack) ack({ ok: false, error: "身份未找到，请重新加入房间。" });
        return;
      }
      const room = member.room;
      const seatIndex = member.seatIndex;
      if (room.roomCode !== (roomCode || "").toUpperCase()) {
        if (ack) ack({ ok: false, error: "房间号不匹配。" });
        return;
      }
      if (!room.gameState || room.status !== "playing") {
        if (ack) ack({ ok: false, error: "游戏尚未开始。" });
        return;
      }
      if (room.gameState.currentPlayerIndex !== seatIndex) {
        if (ack) ack({ ok: false, error: "还没轮到你。" });
        return;
      }

      const result = rules.applyOnlineActionToState(room.gameState, seatIndex, action);
      if (!result.ok) {
        socket.emit("actionRejected", { message: result.error });
        if (ack) ack({ ok: false, error: result.error });
        return;
      }

      room.gameState = result.state;
      room.updatedAt = Date.now();
      broadcastState(room);

      setTimeout(() => {
        runAllAITurns(room);
        broadcastState(room);
      }, 300);

      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    } finally {
      inFlightActions.delete(socket.id);
    }
  });

  // ========== 离开房间（显式）==========
  socket.on("leaveRoom", (payload, ack) => {
    try {
      const member = getMemberBySocket(socket.id);
      if (!member) {
        if (ack) ack({ ok: true });
        return;
      }
      const { room, seat, seatIndex } = member;
      // 显式离开：释放该席位（与刷新/临时断线保留身份语义不同）
      if (!seat.isAI) {
        seat.playerToken = null;
        seat.socketId = null;
        seat.connected = false;
        // 保留名字为 "断线，可同名重连" 视觉
        // 但恢复名字为空以允许新玩家加入
        if (room.status === "waiting") {
          seat.name = "";
        }
        // v0.9.11: 房主显式离开 → 转移房主给第一个在线的非 AI 人类
        if (seat.isHost) {
          seat.isHost = false;
          const newHost = room.players.find((p) => !p.isAI && p.connected && p.socketId);
          if (newHost) {
            newHost.isHost = true;
            room.hostSeatIndex = newHost.seatIndex;
          } else {
            room.hostSeatIndex = -1;
          }
          console.log(`[房主转移] ${room.roomCode} 旧=${seatIndex} 新=${room.hostSeatIndex}`);
        }
      }
      unbindSocketMember(socket.id);
      try { socket.leave(room.roomCode); } catch (e) { /* noop */ }
      room.updatedAt = Date.now();
      // 如果房间已空（无人类玩家且无AI），清理
      const anyHumanAlive = room.players.some(p => !p.isAI && (p.playerToken || p.connected));
      if (!anyHumanAlive && room.aiCount === 0) {
        console.log(`[清理空房] ${room.roomCode}`);
        rooms.delete(room.roomCode);
      } else {
        broadcastRoomUpdate(room);
      }
      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // ========== 断线（保留身份，不清 seat）==========
  socket.on("disconnect", () => {
    const member = getMemberBySocket(socket.id);
    if (!member) {
      // 可能是 spectator 或未绑定的 socket
      let foundRoom = null;
      for (const [code, room] of rooms) {
        const sIdx = room.spectators.indexOf(socket.id);
        if (sIdx >= 0) { room.spectators.splice(sIdx, 1); foundRoom = room; break; }
      }
      if (foundRoom) {
        foundRoom.updatedAt = Date.now();
        broadcastRoomUpdate(foundRoom);
      }
      return;
    }
    const { room, seat, seatIndex } = member;
    // v0.9.11: 刷新/临时断线 → 只标记 connected=false，保留 playerToken/seatIndex/isHost/playerName
    // 绝不：删除 member、抢占 seat、转移房主
    seat.connected = false;
    seat.socketId = null;
    unbindSocketMember(socket.id);
    console.log(`[断线保留] ${seat.name} ${room.roomCode} seat=${seatIndex} host=${seat.isHost}（playerToken 保留）`);

    // 通知其他玩家：该玩家断线
    room.players.forEach((p) => {
      if (p.socketId && p.connected) {
        io.to(p.socketId).emit("playerDisconnected", { seatIndex, name: seat.name });
      }
    });
    room.updatedAt = Date.now();
    broadcastRoomUpdate(room);
  });
});

// =============================
// 过期房间清理
// =============================
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > ROOM_EXPIRE_MS) {
      console.log(`[清理] 过期房间 ${code}`);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000); // 每 10 分钟检查一次

// =============================
// 启动服务器 + 优雅退出
// =============================
// 处理 EADDRINUSE 等监听错误
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用，请先关闭占用该端口的进程或设置 PORT 环境变量。`);
  } else {
    console.error(`服务器启动失败：${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`宝可梦璀璨宝石联机服务器 v${VERSION} 已启动：`);
  console.log(`  监听端口：${PORT}`);
  console.log(`  本机访问：http://localhost:${PORT}`);
  console.log(`  健康检查：http://localhost:${PORT}/health`);
  console.log(`  版本查询：http://localhost:${PORT}/version`);
  // 启动时静态资源诊断（Render 排查用）
  console.log(`[静态资源检查]`);
  console.log(`  __dirname: ${__dirname}`);
  console.log(`  online.js: ${fs.existsSync(path.join(__dirname, "online.js"))}`);
  console.log(`  game.js: ${fs.existsSync(path.join(__dirname, "game.js"))}`);
  console.log(`  bgm.js: ${fs.existsSync(path.join(__dirname, "bgm.js"))}`);
  console.log(`  style.css: ${fs.existsSync(path.join(__dirname, "style.css"))}`);
  console.log(`  cards.json: ${fs.existsSync(path.join(__dirname, "cards.json"))}`);
  try {
    const pkgRoot = path.dirname(require.resolve("socket.io/package.json"));
    const candidate = path.join(pkgRoot, "client-dist", "socket.io.js");
    console.log(`  socket.io client: ${fs.existsSync(candidate)} (${candidate})`);
  } catch (e) {
    console.log(`  socket.io client: 未找到（${e.message}）`);
  }
  const lans = getLanIPv4List();
  if (lans.length > 0) {
    lans.forEach((lan) => {
      console.log(`  局域网访问（${lan.name}）：http://${lan.address}:${PORT}`);
    });
  } else {
    console.log(`  局域网访问：http://<你的IP>:${PORT}（未识别到局域网 IP，请在命令行输入 ipconfig 查看 IPv4 地址。）`);
  }
  if (process.env.RENDER) {
    console.log(`  当前环境：Render 公网部署`);
  }
});

// 优雅退出：SIGINT（Ctrl+C）/ SIGTERM（容器停止）
function gracefulShutdown(signal) {
  console.log(`收到 ${signal} 信号，正在关闭服务器...`);
  try {
    // 1. 关闭 Socket.IO 连接
    io.close(() => {
      console.log("Socket.IO 已关闭。");
    });
  } catch (e) { /* noop */ }
  // 2. 关闭 HTTP 服务器（给正在处理的请求最多 8 秒）
  const shutdownTimer = setTimeout(() => {
    console.error("关闭超时，强制退出。");
    process.exit(0);
  }, 8000);
  shutdownTimer.unref && shutdownTimer.unref();
  try {
    server.close(() => {
      clearTimeout(shutdownTimer);
      console.log("HTTP 服务器已关闭，退出。");
      process.exit(0);
    });
  } catch (e) {
    process.exit(0);
  }
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
