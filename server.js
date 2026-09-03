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
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混字符
const ROOM_CODE_LENGTH = 4;
const ROOM_EXPIRE_MS = 2 * 60 * 60 * 1000; // 2 小时无人操作过期

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

function createRoom(hostSocketId, { playerName, playerCount, aiCount }) {
  const roomCode = generateRoomCode();
  const pc = Math.min(4, Math.max(2, Number(playerCount) || 2));
  const ac = Math.min(pc, Math.max(0, Number(aiCount) || 0));

  const room = {
    roomCode,
    hostSocketId,
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
      socketId: null,
      name: "",
      seatIndex: i,
      connected: false,
      isAI: false
    });
  }

  // AI 占座（从末尾开始）
  for (let i = pc - 1; i >= pc - ac; i--) {
    room.players[i].isAI = true;
    room.players[i].name = `AI ${i + 1}`;
    room.players[i].connected = true;
  }

  // 房主入座
  room.players[0].socketId = hostSocketId;
  room.players[0].name = playerName || "玩家 1";
  room.players[0].connected = true;

  rooms.set(roomCode, room);
  return room;
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
      isAI: p.isAI
    })),
    hostSeatIndex: room.players.findIndex((p) => p.socketId === room.hostSocketId)
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

function broadcastState(room) {
  if (!room.gameState) return;
  room.players.forEach((p) => {
    if (p.socketId && p.connected) {
      io.to(p.socketId).emit("stateUpdated", { roomCode: room.roomCode, gameState: room.gameState });
    }
  });
  room.spectators.forEach((sid) => {
    io.to(sid).emit("stateUpdated", { roomCode: room.roomCode, gameState: room.gameState });
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
io.on("connection", (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 创建房间
  socket.on("createRoom", (payload, ack) => {
    try {
      const { playerName, playerCount, aiCount } = payload || {};
      const room = createRoom(socket.id, { playerName, playerCount, aiCount });
      socket.join(room.roomCode);
      console.log(`[创建房间] ${room.roomCode} by ${playerName}`);
      if (ack) ack({ ok: true, roomCode: room.roomCode, seatIndex: 0, isHost: true, room: sanitizeRoomForClient(room) });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // 加入房间
  socket.on("joinRoom", (payload, ack) => {
    try {
      const { roomCode, playerName } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "房间不存在，请检查房间号。" });
        return;
      }

      // 检查是否有断线重连的同名玩家（允许游戏开始后的重连）
      let seatIndex = -1;
      const reconnectSeat = rules.findReconnectSeat(room.players, playerName || "");
      if (reconnectSeat >= 0) {
        seatIndex = reconnectSeat;
        room.players[seatIndex].socketId = socket.id;
        room.players[seatIndex].connected = true;
        console.log(`[重连] ${playerName} 重回房间 ${room.roomCode} 座位 ${seatIndex}（room.status=${room.status}）`);
      } else if (room.status === "waiting") {
        // 只有 waiting 状态下才接受新玩家填充空位
        seatIndex = rules.findEmptySeat(room.players);
        if (seatIndex < 0) {
          if (ack) ack({ ok: false, error: "房间已满，无法作为玩家加入。" });
          return;
        }
        room.players[seatIndex].socketId = socket.id;
        room.players[seatIndex].name = playerName || `玩家 ${seatIndex + 1}`;
        room.players[seatIndex].connected = true;
        console.log(`[加入房间] ${playerName} 加入 ${room.roomCode} 座位 ${seatIndex}`);
      } else {
        // 游戏已开始 且 不是重连同名玩家 → 拒绝
        // 区分两种情况：座位属于其他玩家（名字不匹配） vs 完全无对应座位
        const disconnectedSeats = room.players.filter((p) => !p.connected && !p.isAI);
        if (disconnectedSeats.length > 0) {
          if (ack) ack({ ok: false, error: "该座位属于其他玩家，请使用原来的玩家名重连。" });
        } else {
          if (ack) ack({ ok: false, error: "游戏已经开始，只允许原玩家同名重连。" });
        }
        return;
      }

      socket.join(room.roomCode);
      room.updatedAt = Date.now();
      broadcastRoomUpdate(room);
      const hostSeat = room.players.findIndex((p) => p.socketId === room.hostSocketId);
      const isHost = hostSeat === seatIndex;
      // 如果游戏正在进行，额外下发当前 state 方便客户端立即恢复
      const resumeGameState = room.gameState ? room.gameState : undefined;
      if (ack) ack({
        ok: true,
        roomCode: room.roomCode,
        seatIndex,
        isHost,
        room: sanitizeRoomForClient(room),
        gameState: resumeGameState
      });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // 开始游戏（仅房主）
  socket.on("startOnlineGame", (payload, ack) => {
    try {
      const { roomCode } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "房间不存在，请检查房间号。" });
        return;
      }
      if (room.hostSocketId !== socket.id) {
        if (ack) ack({ ok: false, error: "只有房主可以开始游戏。" });
        return;
      }
      if (room.status !== "waiting") {
        if (ack) ack({ ok: false, error: "游戏已开始" });
        return;
      }

      startOnlineGame(room);
      broadcastRoomUpdate(room);
      broadcastState(room);

      // 如果当前玩家是 AI，自动执行
      setTimeout(() => {
        runAllAITurns(room);
        broadcastState(room);
      }, 100);

      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // 玩家行动
  socket.on("playerAction", (payload, ack) => {
    try {
      const { roomCode, seatIndex, action } = payload || {};
      const room = rooms.get((roomCode || "").toUpperCase());
      if (!room) {
        if (ack) ack({ ok: false, error: "房间不存在，请检查房间号。" });
        return;
      }
      if (!room.gameState || room.status !== "playing") {
        if (ack) ack({ ok: false, error: "游戏尚未开始。" });
        return;
      }

      const seat = room.players[seatIndex];
      if (!seat || seat.socketId !== socket.id) {
        if (ack) ack({ ok: false, error: "座位信息不匹配。" });
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

      // 如果下一玩家是 AI，自动执行
      setTimeout(() => {
        runAllAITurns(room);
        broadcastState(room);
      }, 300);

      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message });
    }
  });

  // 断线处理
  socket.on("disconnect", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    const seatIndex = room.players.findIndex((p) => p.socketId === socket.id);
    if (seatIndex >= 0) {
      room.players[seatIndex].connected = false;
      room.players[seatIndex].socketId = null;
      console.log(`[断线] ${room.players[seatIndex].name} 离开房间 ${room.roomCode}`);

      // 通知其他玩家
      room.players.forEach((p) => {
        if (p.socketId && p.connected) {
          io.to(p.socketId).emit("playerDisconnected", { seatIndex, name: room.players[seatIndex].name });
        }
      });

      // 如果房主断线，转移房主
      if (room.hostSocketId === socket.id) {
        const newHost = room.players.find((p) => p.connected && !p.isAI);
        room.hostSocketId = newHost ? newHost.socketId : null;
      }
    }

    // 从观战者中移除
    const specIdx = room.spectators.indexOf(socket.id);
    if (specIdx >= 0) room.spectators.splice(specIdx, 1);

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
  console.log(`宝可梦璀璨宝石联机服务器已启动：`);
  console.log(`  监听端口：${PORT}`);
  console.log(`  本机访问：http://localhost:${PORT}`);
  console.log(`  健康检查：http://localhost:${PORT}/health`);
  // 启动时静态资源诊断（Render 排查用）
  console.log(`[静态资源检查]`);
  console.log(`  __dirname: ${__dirname}`);
  console.log(`  online.js: ${fs.existsSync(path.join(__dirname, "online.js"))}`);
  console.log(`  game.js: ${fs.existsSync(path.join(__dirname, "game.js"))}`);
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
