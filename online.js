"use strict";
// =============================
// v0.9.11 客户端联机逻辑
// 依赖 Socket.IO 和 game.js（通过 window.__pokemonSplendorTestAPI）
//
// 关键约定：
//   - 客户端联机会话凭证：roomCode + playerToken
//   - playerName 仅 UI 显示，不作为恢复身份的权威依据
//   - 刷新/Socket reconnect：统一走 resumeRoom(roomCode, playerToken)
//   - createRoom / joinRoom 仅用于第一次进入（服务端返回新 playerToken 后立即存档）
//   - 防异步竞态：onlineResumeInFlight 标记 + 唯一 idempotent 入口 tryResume
// =============================
(function () {
  const api = () => window.__pokemonSplendorTestAPI;

  let socket = null;
  let uiCallbacks = {
    onRoomCreated: null,
    onRoomJoined: null,
    onResumed: null,         // v0.9.11: resumeRoom 成功后通知上层 applyOnlineResumeResult
    onResumeFailed: null,    // v0.9.11: (code) => void  — ROOM_NOT_FOUND / INVALID_PLAYER_TOKEN
    onRoomUpdated: null,
    onStateUpdated: null,
    onActionRejected: null,
    onPlayerDisconnected: null,
    onPlayerReconnected: null,
    onConnectionError: null,
    onConnectChanged: null
  };
  // v0.9.11: 防竞态标记
  let onlineResumeInFlight = false;
  let onlineResumeDone = false;
  // 最后一次 resume 结果缓存（方便幂等跳过）
  let lastResumeResult = null;

  function setCallbacks(cb) {
    Object.assign(uiCallbacks, cb || {});
  }

  function _emitConnectChanged(flag) {
    const setConnected = api?.()?.setOnlineConnected;
    if (typeof setConnected === "function") {
      try { setConnected(Boolean(flag)); } catch (e) { /* noop */ }
    }
    if (uiCallbacks.onConnectChanged) {
      try { uiCallbacks.onConnectChanged(Boolean(flag)); } catch (e) { /* noop */ }
    }
  }

  // v0.9.11: 读取本地持久化在线 session（roomCode + playerToken 为权威）
  function _readSession() {
    try {
      const raw = localStorage.getItem("pokemonSplendorOnlineSession.v1");
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.roomCode || !d.playerToken) return null;
      return d;
    } catch (e) { return null; }
  }

  // v0.9.11: 写入在线 session（只存凭证，不存完整 gameState）
  function _writeSession({ roomCode, playerToken, playerName }) {
    try {
      const prev = (() => {
        try { return JSON.parse(localStorage.getItem("pokemonSplendorOnlineSession.v1") || "null"); } catch (e) { return null; }
      })();
      const toSave = {
        roomCode: String(roomCode || "").toUpperCase(),
        playerToken: String(playerToken || ""),
        playerName: playerName || (prev && prev.playerName) || "",
        savedAt: Date.now()
      };
      localStorage.setItem("pokemonSplendorOnlineSession.v1", JSON.stringify(toSave));
    } catch (e) { /* localStorage 不可用降级静默 */ }
  }

  function _clearSession() {
    try { localStorage.removeItem("pokemonSplendorOnlineSession.v1"); } catch (e) { /* noop */ }
  }

  // v0.9.11: 把服务端返回的 resume / create / join 结果转换成 onlineMode 配置
  // 并设置在线模式（setOnlineMode）
  function _applyOnlineResult(res) {
    if (!res || !res.ok) return false;
    const a = api?.();
    const roomCode = res.roomCode;
    const seatIndex = Number.isInteger(res.seatIndex) ? res.seatIndex : null;
    const isHost = res.isHost === true;
    const spectatorIndex = typeof res.spectatorIndex === "number" ? res.spectatorIndex : null;
    if (a && typeof a.setOnlineMode === "function") {
      a.setOnlineMode({ socket, roomCode, seatIndex, isHost, spectatorIndex });
    }
    // 如果有 playerToken，持久化（刷新后恢复）
    if (res.playerToken && res.roomCode) {
      _writeSession({
        roomCode: res.roomCode,
        playerToken: res.playerToken,
        playerName: res.playerName || ""
      });
    }
    return true;
  }

  function connect() {
    if (socket && socket.connected) return socket;
    socket = io({ transports: ["websocket", "polling"] });

    socket.on("connect", () => {
      _emitConnectChanged(true);
    });

    socket.on("disconnect", () => {
      _emitConnectChanged(false);
    });

    socket.on("reconnect", () => {
      _emitConnectChanged(true);
      // v0.9.11: Socket.IO 自动重连成功 → 用本地 playerToken 执行 resumeRoom
      _tryResumeFromLocal(false /* don't treat as page boot */);
    });

    socket.on("reconnect_attempt", () => {
      _emitConnectChanged(false);
    });

    socket.on("roomUpdated", (data) => {
      if (uiCallbacks.onRoomUpdated) uiCallbacks.onRoomUpdated(data);
    });

    socket.on("stateUpdated", (data) => {
      if (data && data.gameState) {
        const a = api?.();
        if (a && typeof a.setOnlineState === "function") a.setOnlineState(data.gameState);
      }
      if (uiCallbacks.onStateUpdated) uiCallbacks.onStateUpdated(data);
    });

    socket.on("actionRejected", (data) => {
      if (uiCallbacks.onActionRejected) uiCallbacks.onActionRejected(data);
    });

    socket.on("playerDisconnected", (data) => {
      if (uiCallbacks.onPlayerDisconnected) uiCallbacks.onPlayerDisconnected(data);
    });

    socket.on("playerReconnected", (data) => {
      if (uiCallbacks.onPlayerReconnected) uiCallbacks.onPlayerReconnected(data);
    });

    socket.on("connect_error", (err) => {
      _emitConnectChanged(false);
      if (uiCallbacks.onConnectionError) uiCallbacks.onConnectionError(err);
    });

    return socket;
  }

  // v0.9.11: 幂等的 resume 入口。页面 boot、URL ?room=、Socket reconnect 都走这里。
  // 防重复：同一生命周期（到离开房间/失败清零前）只跑一次成功的 resume；若正在 in_flight 则等待。
  // opts.isPageBoot = true 表示页面刚加载（boot 阶段），失败时上层要决定是否回初始界面。
  function _tryResumeFromLocal(isPageBoot) {
    if (!socket) connect();
    if (onlineResumeDone && lastResumeResult) {
      // 已成功过，直接回调再次应用
      if (uiCallbacks.onResumed) { try { uiCallbacks.onResumed(lastResumeResult); } catch(e){ /* noop */ } }
      return Promise.resolve(lastResumeResult);
    }
    if (onlineResumeInFlight) {
      // 正在执行，简单跳过（上层会收到之前的回调）
      return Promise.resolve(null);
    }
    const sess = _readSession();
    if (!sess) return Promise.resolve(null);
    onlineResumeInFlight = true;
    return new Promise((resolve) => {
      const done = (res, ok) => {
        onlineResumeInFlight = false;
        if (ok) {
          onlineResumeDone = true;
          lastResumeResult = res;
        }
        resolve(ok ? res : null);
      };
      try {
        if (!socket || !socket.connected) {
          socket.once("connect", () => _emitResume());
        } else {
          _emitResume();
        }
      } catch (e) {
        done(null, false);
      }
      function _emitResume() {
        socket.emit("resumeRoom", {
          roomCode: sess.roomCode,
          playerToken: sess.playerToken
        }, (res) => {
          if (res && res.ok) {
            _applyOnlineResult(res);
            if (uiCallbacks.onResumed) { try { uiCallbacks.onResumed(res); } catch(e){ /* noop */ } }
            done(res, true);
          } else {
            const code = res?.code || (res && res.error && String(res.error).indexOf("ROOM_NOT_FOUND") >= 0 ? "ROOM_NOT_FOUND" : "INVALID_PLAYER_TOKEN");
            // v0.9.11: 只有 ROOM_NOT_FOUND / INVALID_PLAYER_TOKEN 才清 session
            if (code === "ROOM_NOT_FOUND" || code === "INVALID_PLAYER_TOKEN") {
              _clearSession();
              onlineResumeDone = false;
              lastResumeResult = null;
            }
            if (uiCallbacks.onResumeFailed) { try { uiCallbacks.onResumeFailed(code, res?.error); } catch(e){ /* noop */ } }
            done(null, false);
          }
        });
      }
    });
  }

  function createRoom(playerName, playerCount, aiCount) {
    return new Promise((resolve, reject) => {
      if (!socket) connect();
      const run = () => {
        socket.emit("createRoom", { playerName, playerCount, aiCount }, (res) => {
          if (res && res.ok) {
            _applyOnlineResult(res);
            if (uiCallbacks.onRoomCreated) uiCallbacks.onRoomCreated(res);
            resolve(res);
          } else {
            reject(new Error(res ? res.error : "创建房间失败"));
          }
        });
      };
      if (socket.connected) run();
      else socket.once("connect", run);
    });
  }

  function joinRoom(roomCode, playerName) {
    return new Promise((resolve, reject) => {
      if (!socket) connect();
      const run = () => {
        socket.emit("joinRoom", { roomCode: String(roomCode || "").toUpperCase(), playerName }, (res) => {
          if (res && res.ok) {
            _applyOnlineResult(res);
            if (uiCallbacks.onRoomJoined) uiCallbacks.onRoomJoined(res);
            resolve(res);
          } else {
            // v0.9.11: 如果服务器提示 GAME_STARTED_USE_RESUME（旧客户端意外走到 joinRoom）
            // 尝试走 resume 流程
            if (res?.code === "GAME_STARTED_USE_RESUME") {
              const sess = _readSession();
              if (sess && sess.roomCode === String(roomCode || "").toUpperCase()) {
                _tryResumeFromLocal(false).then((r) => {
                  if (r) resolve(r); else reject(new Error(res ? res.error : "加入房间失败"));
                }).catch(() => reject(new Error(res ? res.error : "加入房间失败")));
                return;
              }
            }
            reject(new Error(res ? res.error : "加入房间失败"));
          }
        });
      };
      if (socket.connected) run();
      else socket.once("connect", run);
    });
  }

  // v0.9.11: 显式暴露给 game.js boot / applyRoomCodeFromUrl 调用
  function resumeRoom(roomCode, playerToken) {
    // 优先用传入；不传则读本地
    if (roomCode && playerToken) {
      _writeSession({ roomCode, playerToken, playerName: "" });
    }
    return _tryResumeFromLocal(false);
  }

  function startOnlineGame(roomCode) {
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error("未连接服务器")); return; }
      socket.emit("startOnlineGame", { roomCode }, (res) => {
        if (res && res.ok) resolve(res);
        else reject(new Error(res ? res.error : "开始游戏失败"));
      });
    });
  }

  function leaveRoom() {
    return new Promise((resolve) => {
      if (socket) {
        socket.emit("leaveRoom", {}, () => { /* noop */ });
      }
      const a = api?.();
      if (a && typeof a.clearOnlineMode === "function") a.clearOnlineMode();
      _clearSession();
      // 重置 resume 状态（允许下次再进新房间）
      onlineResumeInFlight = false;
      onlineResumeDone = false;
      lastResumeResult = null;
      if (socket) {
        try { socket.disconnect(); } catch (e) { /* noop */ }
        socket = null;
      }
      resolve();
    });
  }

  function disconnect() {
    const a = api?.();
    if (a && typeof a.clearOnlineMode === "function") a.clearOnlineMode();
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  function getSocket() { return socket; }

  function getSessionSnapshot() {
    return _readSession();
  }

  // v0.9.11: 暴露到全局（game.js 调用）
  window.__pokemonOnline = {
    connect,
    createRoom,
    joinRoom,
    resumeRoom,               // v0.9.11: 唯一权威恢复入口
    startOnlineGame,
    leaveRoom,                // v0.9.11: 显式离开
    disconnect,
    setCallbacks,
    getSocket,
    getSessionSnapshot,       // v0.9.11: 调试用
    _clearSession             // v0.9.11: 暴露清理（测试/调试用）
  };
})();
