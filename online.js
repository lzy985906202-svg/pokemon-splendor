"use strict";
// =============================
// v0.9.1 客户端联机逻辑
// 依赖 Socket.IO 和 game.js（通过 window.__pokemonSplendorTestAPI）
// =============================
(function () {
  const api = () => window.__pokemonSplendorTestAPI;

  let socket = null;
  let uiCallbacks = {
    onRoomCreated: null,
    onRoomJoined: null,
    onRoomUpdated: null,
    onStateUpdated: null,
    onActionRejected: null,
    onPlayerDisconnected: null,
    onPlayerReconnected: null,
    onConnectionError: null,
    onConnectChanged: null // (connected: boolean) => void
  };

  function setCallbacks(cb) {
    Object.assign(uiCallbacks, cb);
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
      // P1-2 修复：socket.io 自动重连后自动重新加入房间，避免用户手动点击"加入房间"
      try {
        const sessionRaw = localStorage.getItem("pokemonSplendorOnlineSession.v1");
        if (sessionRaw) {
          const session = JSON.parse(sessionRaw);
          if (session && session.roomCode && session.playerName) {
            // 用 setTimeout 0 确保 socket 完全 ready 后再 emit
            setTimeout(() => {
              if (socket && socket.connected) {
                socket.emit("joinRoom", { roomCode: session.roomCode, playerName: session.playerName }, (res) => {
                  if (res && res.ok) {
                    const a = api?.();
                    if (a && typeof a.setOnlineMode === "function") {
                      a.setOnlineMode({
                        socket,
                        roomCode: res.roomCode,
                        seatIndex: res.seatIndex,
                        isHost: res.isHost === true,
                        spectatorIndex: typeof res.spectatorIndex === "number" ? res.spectatorIndex : null
                      });
                    }
                    if (res.gameState && a && typeof a.setOnlineState === "function") {
                      a.setOnlineState(res.gameState);
                    }
                  }
                });
              }
            }, 0);
          }
        }
      } catch (e) { /* noop */ }
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

  function createRoom(playerName, playerCount, aiCount) {
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error("未连接服务器")); return; }
      socket.emit("createRoom", { playerName, playerCount, aiCount }, (res) => {
        if (res && res.ok) {
          const a = api?.();
          if (a && typeof a.setOnlineMode === "function") {
            a.setOnlineMode({
              socket,
              roomCode: res.roomCode,
              seatIndex: res.seatIndex,
              isHost: true
            });
          }
          if (uiCallbacks.onRoomCreated) uiCallbacks.onRoomCreated(res);
          resolve(res);
        } else {
          reject(new Error(res ? res.error : "创建房间失败"));
        }
      });
    });
  }

  function joinRoom(roomCode, playerName) {
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error("未连接服务器")); return; }
      socket.emit("joinRoom", { roomCode: roomCode.toUpperCase(), playerName }, (res) => {
        if (res && res.ok) {
          const a = api?.();
          if (a && typeof a.setOnlineMode === "function") {
            a.setOnlineMode({
              socket,
              roomCode: res.roomCode,
              seatIndex: res.seatIndex,
              isHost: res.isHost === true,
              spectatorIndex: typeof res.spectatorIndex === "number" ? res.spectatorIndex : null
            });
          }
          // 断线重连：服务器返回 gameState（当前正在进行的游戏）时，直接恢复
          if (res.gameState && a && typeof a.setOnlineState === "function") {
            a.setOnlineState(res.gameState);
          }
          if (uiCallbacks.onRoomJoined) uiCallbacks.onRoomJoined(res);
          resolve(res);
        } else {
          reject(new Error(res ? res.error : "加入房间失败"));
        }
      });
    });
  }

  function startOnlineGame(roomCode) {
    return new Promise((resolve, reject) => {
      if (!socket) { reject(new Error("未连接服务器")); return; }
      socket.emit("startOnlineGame", { roomCode }, (res) => {
        if (res && res.ok) {
          resolve(res);
        } else {
          reject(new Error(res ? res.error : "开始游戏失败"));
        }
      });
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

  // 暴露到全局
  window.__pokemonOnline = {
    connect,
    createRoom,
    joinRoom,
    startOnlineGame,
    disconnect,
    setCallbacks,
    getSocket
  };
})();
