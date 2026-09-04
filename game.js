(function () {
  "use strict";

  // =============================
  // Node.js 环境兼容（服务器复用纯逻辑函数）
  // =============================
  const __isNode = (typeof window === "undefined");
  if (__isNode) {
    global.window = { __pokemonSplendorIsTesting: false };
    global.document = {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
      body: { className: "", classList: { add: () => {}, remove: () => {}, contains: () => false } }
    };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    global.fetch = () => Promise.reject(new Error("no fetch in node"));
    global.window.confirm = () => true;
    global.window.setTimeout = setTimeout;
    global.window.clearTimeout = clearTimeout;
  }

  // =============================
  // 常量与工具函数
  // =============================
  const STORAGE_KEY = "pokemonSplendorGameState.v1";
  const CARD_DATA_PATHS = ["cards.json", "data/cards.json"];
  const CARD_CACHE_KEY = "pokemonSplendorCardData.v1";
  const NORMAL_COLORS = ["red", "blue", "black", "pink", "yellow"];
  const ALL_COLORS = [...NORMAL_COLORS, "purple"];
  const MARKET_KEYS = ["level3", "level2", "level1", "rare", "legend"];
  const TOKEN_LABELS = {
    red: "精灵球",
    blue: "超级球",
    black: "高级球",
    pink: "治愈球",
    yellow: "先机球",
    purple: "大师球"
  };
  const MARKET_LABELS = {
    level1: "1 级",
    level2: "2 级",
    level3: "3 级",
    rare: "稀有",
    legend: "传说"
  };
  const INITIAL_SUPPLY = {
    2: { red: 4, blue: 4, black: 4, pink: 4, yellow: 4, purple: 5 },
    3: { red: 5, blue: 5, black: 5, pink: 5, yellow: 5, purple: 5 },
    4: { red: 7, blue: 7, black: 7, pink: 7, yellow: 7, purple: 5 }
  };

  const els = {};
  let cardDatabase = [];
let cardDataSource = "";
let gameState = null;
let historyStack = [];
let isRestoringHistory = false;
let aiThinking = false;
let aiTimerId = null;
let aiTurnKey = null;
let aiScheduleVersion = 0;
let aiPaused = false;
let pendingTokenSelection = [];
// v0.9.0 联机模式状态
let onlineMode = false;
let onlineSocket = null;
let onlineRoomCode = "";
let onlineSeatIndex = null;
let onlineIsHost = false;
let onlineSpectatorIndex = null; // null = 非观战；>=0 表示在玩家列表末尾的观战者 index（纯展示）
let onlineConnected = false; // socket 连接状态
const AI_STEP_DELAY = 900;
const MAX_AUTO_TURNS = 120;
function isTestingMode() {
  return Boolean(window.__pokemonSplendorIsTesting);
}
function getAIPlayerCount(state = gameState) {
  return (state?.players || []).filter((player) => player.isAI).length;
}
function isFastSpectatorAI() {
  return Boolean(gameState?.spectatorMode && getAIPlayerCount() >= 4);
}
function getAIStepDelay() {
  if (isTestingMode()) return 0;
  if (isFastSpectatorAI()) return 200;
  const value = localStorage.getItem("pokemonSplendorAISpeed") || "normal";
  if (value === "slow") return 1400;
  if (value === "fast") return 400;
  return 900;
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function $(id) {
    return document.getElementById(id);
  }

  function emptyTokens() {
    return { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, purple: 0 };
  }

  function normalizeTokens(value) {
    const tokens = emptyTokens();
    const source = value && typeof value === "object" ? value : {};
    ALL_COLORS.forEach((color) => {
      const amount = Number(source[color]);
      tokens[color] = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
    });
    return tokens;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function shuffle(cards) {
    const result = clone(cards);
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function totalTokens(tokens) {
    return ALL_COLORS.reduce((sum, color) => sum + (Number(tokens[color]) || 0), 0);
  }

  function sumPoints(cards) {
    return cards.reduce((sum, card) => sum + (Number(card.points) || 0), 0);
  }

  function getCardName(card) {
    return card?.name_zh || card?.name_en || card?.id || "未知卡牌";
  }

  function normalizeCategory(category) {
    const raw = String(category || "normal").toLowerCase();
    if (raw === "legendary" || raw === "legend") return "legend";
    if (raw === "rare") return "rare";
    return "normal";
  }

  function normalizeCard(raw, index) {
    const source = raw && typeof raw === "object" ? raw : {};
    const nameZh = String(source.name_zh || source.name || source.name_en || `未知卡牌 ${index + 1}`);
    const id = String(source.id || `${nameZh}_${index + 1}`);
    return {
      id,
      name_zh: nameZh,
      name_en: String(source.name_en || ""),
      category: normalizeCategory(source.category),
      level: Number(source.level) || 0,
      points: Number(source.points) || 0,
      bonus: {
        color: ALL_COLORS.includes(source.bonus?.color) ? source.bonus.color : "",
        count: Math.max(0, Number(source.bonus?.count) || 0)
      },
      cost: normalizeTokens(source.cost),
      evolutionLine: String(source.evolutionLine || ""),
      evolvesTo: String(source.evolvesTo || ""),
      evolveCost: normalizeTokens(source.evolveCost),
      copyIndex: Number(source.copyIndex) || 0,
      image: String(source.image || "")
    };
  }

  function normalizeCardList(payload) {
    const cards = Array.isArray(payload) ? payload : Array.isArray(payload?.cards) ? payload.cards : [];
    return cards.map(normalizeCard);
  }

  function cardMarketKey(card) {
    if (!card) return "";
    if (card.category === "rare") return "rare";
    if (card.category === "legend") return "legend";
    if (card.category === "normal" && card.level === 1) return "level1";
    if (card.category === "normal" && card.level === 2) return "level2";
    if (card.category === "normal" && card.level === 3) return "level3";
    return "";
  }

  function marketSize(key) {
    return key === "rare" || key === "legend" ? 1 : 4;
  }

  function tokenText(tokens, includeZero = false) {
    const parts = ALL_COLORS
      .filter((color) => includeZero || (Number(tokens[color]) || 0) > 0)
      .map((color) => `${TOKEN_LABELS[color]} ${Number(tokens[color]) || 0}`);
    return parts.length ? parts.join("，") : "无";
  }

  function normalTokenText(tokens, includeZero = false) {
    const parts = NORMAL_COLORS
      .filter((color) => includeZero || (Number(tokens[color]) || 0) > 0)
      .map((color) => `${TOKEN_LABELS[color]} ${Number(tokens[color]) || 0}`);
    return parts.length ? parts.join("，") : "无";
  }

  function cardTypeText(card) {
    if (card.category === "rare") return "稀有";
    if (card.category === "legend") return "传说";
    return `${card.level || "?"} 级`;
  }

  function bonusText(card) {
    if (!card?.bonus?.color || !card.bonus.count) return "无";
    return `${TOKEN_LABELS[card.bonus.color] || card.bonus.color} x${card.bonus.count}`;
  }

  function renderTokenIcons(tokens, options = {}) {
    const safeTokens = normalizeTokens(tokens);
    const colors = options.includePurple === false ? NORMAL_COLORS : ALL_COLORS;
    const includeZero = Boolean(options.includeZero);
    const size = options.size || "small";
    const parts = colors
      .filter((color) => includeZero || (Number(safeTokens[color]) || 0) > 0)
      .map((color) => {
        const originalSrc = `assets/tokens/${color}.png`;
        const thumbSrc = getTokenThumbnailPath(color);
        const imgTag = buildImgTagWithFallback(thumbSrc, { alt: TOKEN_LABELS[color], loading: "lazy", decoding: "async", fallbackSrc: originalSrc });
        return `
        <span class="token-icon-token token-icon-${size}" data-token-color="${color}">
          ${imgTag}
          <span>${Number(safeTokens[color]) || 0}</span>
        </span>
      `;
      });
    return parts.length ? parts.join("") : `<span class="muted">无</span>`;
  }

  function renderBonusIcon(card) {
    if (!card?.bonus?.color || !card?.bonus?.count) return `<span class="muted">无</span>`;
    const tokens = emptyTokens();
    tokens[card.bonus.color] = card.bonus.count;
    return renderTokenIcons(tokens);
  }

  function notify(message, type = "info") {
    els.messageBar.textContent = message || "";
    els.messageBar.className = `message ${type}`;
  }

  function pushHistorySnapshot() {
    if (!gameState || isRestoringHistory) return;
    historyStack.push(JSON.stringify(gameState));
    if (historyStack.length > 10) historyStack.shift();
  }

  function undoLastAction() {
    if (!historyStack.length) {
      notify("没有可撤销的操作。", "warn");
      return;
    }
    clearAISchedule();
    const raw = historyStack.pop();
    try {
      isRestoringHistory = true;
      gameState = hydrateGameState(JSON.parse(raw));
      notify("已撤销上一步操作。", "info");
      saveGame();
      render();
    } catch (error) {
      console.error("撤销失败：", error);
      notify("撤销失败，请查看控制台。", "error");
    } finally {
      isRestoringHistory = false;
    }
  }

  function setVisible(element, visible) {
    if (!element) return;
    element.classList.toggle("hidden", !visible);
  }

  // =============================
  // 游戏状态
  // =============================
  function createPlayer(index) {
    return {
      id: `player_${index + 1}`,
      name: `玩家 ${index + 1}`,
      tokens: emptyTokens(),
      reserved: [],
      tableau: [],
      evolvedArchive: [],
      score: 0,
      isAI: false
    };
  }

  function createEmptyGameState(playerCount) {
    return {
      version: 1,
      playerCount,
      players: Array.from({ length: playerCount }, (_, index) => createPlayer(index)),
      playerTurns: Array.from({ length: playerCount }, () => 0),
      supply: clone(INITIAL_SUPPLY[playerCount]),
      decks: { level1: [], level2: [], level3: [], rare: [], legend: [] },
      market: { level1: [], level2: [], level3: [], rare: [], legend: [] },
      currentPlayerIndex: 0,
      turnNumber: 1,
      phase: "awaitAction",
      mainActionDone: false,
      didEvolveThisTurn: false,
      selectedCard: null,
      finalRoundTriggered: false,
      finalTriggerPlayerIndex: null,
      finalTargetTurnCount: null,
      aiType: "mcts",
      actionLog: [],
      gameOver: false,
      lastMessage: "",
      // v0.7 联机预留字段（暂时不启用）
      onlineMode: false,
      roomId: "",
      localPlayerIndex: 0
    };
  }

  function currentPlayer() {
    return gameState?.players[gameState.currentPlayerIndex] || null;
  }

  // v0.9.1 联机模式：本地玩家（底部玩家区应显示此玩家）
  function localPlayer() {
    if (!gameState) return currentPlayer();
    if (!onlineMode) return currentPlayer(); // 单机共享屏幕：底部显示当前行动的玩家
    if (onlineSpectatorIndex != null) {
      return gameState.players[gameState.currentPlayerIndex] || null; // 观战模式：显示行动中的玩家
    }
    if (onlineSeatIndex == null) return currentPlayer();
    return gameState.players[onlineSeatIndex] || null;
  }

  function onlineIdentityText() {
    if (!onlineMode) return "单机模式";
    if (onlineSpectatorIndex != null) return "你是观战者";
    if (onlineSeatIndex == null) return "你：等待分配座位";
    return `你是玩家 ${onlineSeatIndex + 1}`;
  }

  function onlineConnectText() {
    if (!onlineMode) return "";
    if (!onlineConnected) return "连接断开，正在重连...";
    return "已连接";
  }

  // v0.9.2 房间号规范化（统一大写、去空格）
  function normalizeRoomCode(code) {
    return String(code || "").trim().toUpperCase();
  }

  // v0.9.2 拼接加入链接（基于当前页面地址）
  // v0.9.3 公网部署：直接基于 window.location.origin，Render 公网域名下会自动生成 onrender.com 链接
  function buildJoinLink(roomCode) {
    const code = normalizeRoomCode(roomCode);
    if (typeof window === "undefined" || !window.location) return `?room=${code}`;
    const origin = window.location.origin + window.location.pathname;
    return `${origin}?room=${encodeURIComponent(code)}`;
  }

  // v0.9.3 判断当前访问是否属于本地/局域网地址（非 Render 公网）
  // 返回 true：localhost / 127.0.0.1 / 192.168.x.x / 10.x.x.x / 172.(16-31).x.x / [::1] / file://
  // 当传入参数：优先解析该参数（支持完整 URL "https://xxx.com"、hostname、IPv4）；
  // 当未传入参数：从 window.location.hostname 取当前页面 hostname
  function isPrivateNetworkOrigin(originOrHostname) {
    let host = String(originOrHostname == null ? "" : originOrHostname);
    if (!host) {
      // 无参数 → 用当前页面 hostname
      if (typeof window !== "undefined" && window.location && typeof window.location.hostname === "string") {
        host = window.location.hostname;
      }
    } else if (host.startsWith("http://") || host.startsWith("https://") || host.startsWith("file://")) {
      // 传入的是完整 URL → 从 URL 提取 hostname
      try {
        const u = new URL(host);
        host = u.hostname;
      } catch (e) { /* keep original string */ }
    }
    // 否则认为传入的已经是 hostname / IP / 空串
    if (!host) return false;
    if (host === "localhost" || host === "::1") return true;
    if (host === "127.0.0.1") return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
    return false;
  }

  // v0.9.4 卡牌缩略图路径转换（assets/cards/xxx.png → assets/cards/thumbs/xxx.webp）
  // 不修改 cards.json 中的原始路径，仅在渲染时用缩略图；查看大图时仍用原 PNG
  function getCardThumbnailPath(imagePath) {
    const p = String(imagePath || "");
    if (!p) return p;
    // 仅对 assets/cards/*.png 转换
    if (p.indexOf("assets/cards/") === 0 && p.toLowerCase().endsWith(".png")) {
      const baseName = p.substring("assets/cards/".length, p.length - ".png".length);
      return `assets/cards/thumbs/${baseName}.webp`;
    }
    return p;
  }

  // v0.9.4 Token 缩略图路径转换（assets/tokens/xxx.png → assets/tokens/thumbs/xxx.webp）
  function getTokenThumbnailPath(colorOrPath) {
    const p = String(colorOrPath || "");
    if (!p) return p;
    // 传入的是颜色名（如 "red"）→ 转为 assets/tokens/thumbs/red.webp
    if (p.indexOf("/") < 0 && p.indexOf("\\") < 0 && p.indexOf(".") < 0) {
      return `assets/tokens/thumbs/${p}.webp`;
    }
    // 传入的是完整路径
    if (p.indexOf("assets/tokens/") === 0 && p.toLowerCase().endsWith(".png")) {
      const baseName = p.substring("assets/tokens/".length, p.length - ".png".length);
      return `assets/tokens/thumbs/${baseName}.webp`;
    }
    return p;
  }

  // v0.9.4 生成带 onerror fallback 的 img 标签（缩略图加载失败时回退到原 PNG）
  function buildImgTagWithFallback(src, options) {
    const opts = options || {};
    const cls = opts.className ? ` class="${escapeHtml(opts.className)}"` : "";
    const alt = opts.alt ? ` alt="${escapeHtml(opts.alt)}"` : "";
    const loading = opts.loading ? ` loading="${escapeHtml(opts.loading)}"` : "";
    const decoding = opts.decoding ? ` decoding="${escapeHtml(opts.decoding)}"` : "";
    // onerror: 清除自身 onerror 防止无限循环，然后回退到原始路径
    const onerror = opts.fallbackSrc
      ? ` onerror="this.onerror=null;this.src='${escapeHtml(opts.fallbackSrc)}'"`
      : "";
    return `<img${cls} src="${escapeHtml(src)}"${alt}${loading}${decoding}${onerror}>`;
  }

  // v0.9.2 联机重连纯逻辑（供 server.js 与测试复用）
  // 返回断线且同名（非 AI）的座位索引，找不到返回 -1
  function findReconnectSeat(players, playerName) {
    if (!Array.isArray(players)) return -1;
    const name = String(playerName || "");
    return players.findIndex((p) => p && !p.connected && !p.isAI && p.name === name);
  }

  // v0.9.2 查找空座位（未连接且非 AI），找不到返回 -1
  function findEmptySeat(players) {
    if (!Array.isArray(players)) return -1;
    // v0.9.11：空位 = 没有稳定 playerToken 且不是 AI
    // 注意：connected=false（临时断线）的玩家仍然"有人占用"，不能被当作空seat覆盖
    return players.findIndex((p) => p && !p.isAI && (p.playerToken == null || p.playerToken === ""));
  }

  function resolvePlayerIndex(playerRef) {
    if (!gameState) return -1;
    if (Number.isInteger(playerRef)) return playerRef;
    if (typeof playerRef === "string") {
      return gameState.players.findIndex((player) => player.id === playerRef);
    }
    if (playerRef && typeof playerRef === "object") {
      const directIndex = gameState.players.indexOf(playerRef);
      if (directIndex >= 0) return directIndex;
      if (typeof playerRef.id === "string") {
        return gameState.players.findIndex((player) => player.id === playerRef.id);
      }
      if (Number.isInteger(playerRef.id)) return playerRef.id;
    }
    return -1;
  }

  function updatePlayerScore(player) {
    player.score = sumPoints(player.tableau);
  }

  function saveGame() {
    if (!gameState) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
  }

  function loadSavedGame() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return hydrateGameState(JSON.parse(raw));
    } catch (error) {
      console.warn("存档读取失败", error);
      return null;
    }
  }

  function clearSavedGame() {
    clearAISchedule();
    localStorage.removeItem(STORAGE_KEY);
  }

  function hydrateGameState(saved) {
    const state = saved && typeof saved === "object" ? saved : createEmptyGameState(2);
    const playerCount = Math.min(4, Math.max(2, Number(state.playerCount) || Number(state.players?.length) || 2));
    const hydrated = {
      ...createEmptyGameState(playerCount),
      ...state,
      playerCount
    };
    hydrated.supply = normalizeTokens(hydrated.supply);
    hydrated.decks = hydrateCardBuckets(hydrated.decks);
    hydrated.market = hydrateCardBuckets(hydrated.market);
    hydrated.players = Array.from({ length: playerCount }, (_, index) => {
      const savedPlayer = hydrated.players?.[index] || {};
      const player = { ...createPlayer(index), ...savedPlayer };
      player.isAI = Boolean(savedPlayer.isAI ?? player.isAI ?? false);
      player.tokens = normalizeTokens(player.tokens);
      player.reserved = (player.reserved || []).map(normalizeCard);
      player.tableau = (player.tableau || []).map(normalizeCard);
      player.evolvedArchive = (player.evolvedArchive || []).map(normalizeCard);
      updatePlayerScore(player);
      return player;
    });
    hydrated.playerTurns = Array.from({ length: playerCount }, (_, index) => Number(hydrated.playerTurns?.[index]) || 0);
    hydrated.spectatorMode = Boolean(hydrated.spectatorMode ?? false);
    hydrated.aiType = "mcts";
    hydrated.actionLog = Array.isArray(hydrated.actionLog) ? hydrated.actionLog.slice(-120) : [];
    if (!["awaitAction", "discard", "evolve", "gameOver"].includes(hydrated.phase)) {
      hydrated.phase = "awaitAction";
    }
    return hydrated;
  }

  function hydrateCardBuckets(buckets) {
    const result = { level1: [], level2: [], level3: [], rare: [], legend: [] };
    MARKET_KEYS.forEach((key) => {
      result[key] = Array.isArray(buckets?.[key]) ? buckets[key].map(normalizeCard) : [];
    });
    return result;
  }

  // =============================
  // 初始化与洗牌
  // =============================
  async function loadCardDataAutomatically() {
    const errors = [];
    for (const path of CARD_DATA_PATHS) {
      try {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const payload = await response.json();
        const cards = normalizeCardList(payload);
        if (!cards.length) throw new Error("未找到 cards 数组");
        cardDataSource = path;
        cardDatabase = cards;
        saveCardDataCache(payload, path);
        return cards;
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
        if (errors.length < CARD_DATA_PATHS.length) {
          console.warn(`卡牌数据路径 ${path} 读取失败，尝试下一个路径...`);
        }
      }
    }
    const cachedCards = loadCardDataFromCache();
    if (cachedCards && cachedCards.length) {
      cardDatabase = cachedCards;
      return cachedCards;
    }
    throw new Error(errors.join("；"));
  }

  function saveCardDataCache(payload, sourceName) {
    try {
      localStorage.setItem(CARD_CACHE_KEY, JSON.stringify({
        sourceName: sourceName || "manual",
        savedAt: Date.now(),
        payload
      }));
    } catch (error) {
      console.warn("卡牌数据缓存失败：", error);
    }
  }

  function loadCardDataFromCache() {
    try {
      const raw = localStorage.getItem(CARD_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw);
      const cards = normalizeCardList(cached.payload);
      if (!cards.length) return null;
      cardDataSource = cached.sourceName
        ? `${cached.sourceName}（缓存）`
        : "localStorage 缓存";
      return cards;
    } catch (error) {
      console.warn("卡牌数据缓存读取失败：", error);
      return null;
    }
  }

  function loadCardDataFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(String(reader.result || ""));
          const cards = normalizeCardList(payload);
          if (!cards.length) throw new Error("未找到 cards 数组");
          cardDataSource = file.name;
          cardDatabase = cards;
          saveCardDataCache(payload, file.name);
          resolve(cards);
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsText(file, "utf-8");
    });
  }

  function buildDecks(cards) {
    const decks = { level1: [], level2: [], level3: [], rare: [], legend: [] };
    cards.forEach((card) => {
      const key = cardMarketKey(card);
      if (key && decks[key]) decks[key].push(card);
    });
    MARKET_KEYS.forEach((key) => {
      decks[key] = shuffle(decks[key]);
    });
    return decks;
  }

  function drawToMarket(key) {
    const targetSize = marketSize(key);
    while (gameState.market[key].length < targetSize && gameState.decks[key].length > 0) {
      gameState.market[key].push(gameState.decks[key].pop());
    }
  }

  function refillAllMarkets() {
    MARKET_KEYS.forEach(drawToMarket);
  }

  function startNewGame(playerCount) {
    if (!cardDatabase.length) {
      notify("还没有可用的卡牌数据。请选择 cards.json。", "error");
      return;
    }
    clearAISchedule();
    gameState = createEmptyGameState(playerCount);
    gameState.decks = buildDecks(cardDatabase);
    refillAllMarkets();
    gameState.aiType = "mcts";

    const aiCount = Math.min(Number(els.aiCount?.value) || 0, playerCount);
    if (aiCount === playerCount) {
      for (let i = 0; i < playerCount; i++) {
        gameState.players[i].isAI = true;
        gameState.players[i].name = `AI 玩家 ${i + 1}`;
      }
      gameState.spectatorMode = true;
    } else {
      for (let i = playerCount - aiCount; i < playerCount; i++) {
        gameState.players[i].isAI = true;
        gameState.players[i].name = `玩家 ${i + 1}（AI）`;
      }
      gameState.spectatorMode = false;
    }

    aiPaused = false;
    historyStack = [];
    notify(`已开始 ${playerCount} 人游戏。${gameState.spectatorMode ? "观战模式：所有玩家均由 AI 控制。" : ""}`, "info");
    saveGame();
    render();
    if (aiCount > 0) maybeRunAITurn();
  }

  // =============================
  // 玩家行动
  // =============================
  // 统一规则动作 (perform)
  // =============================
  function requireActionPhase() {
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      notify("当前不能执行主要行动。", "error");
      return false;
    }
    if (onlineMode && !isOnlineLocalTurn()) {
      notify("还没轮到你。", "warn");
      return false;
    }
    return true;
  }

  function completeMainAction(message) {
    const player = currentPlayer();
    gameState.mainActionDone = true;
    gameState.phase = totalTokens(player.tokens) > 10 ? "discard" : "evolve";
    gameState.lastMessage = message;
    if (message) notify(message, "info");
    saveGame();
    render();
  }

  function calculateDiscount(player) {
    const discount = emptyTokens();
    player.tableau.forEach((card) => {
      if (card.bonus && card.bonus.color && card.bonus.count) {
        discount[card.bonus.color] = (discount[card.bonus.color] || 0) + card.bonus.count;
      }
    });
    return discount;
  }

  function calculatePayCost(player, card) {
    const cost = normalizeTokens(card.cost);
    const discount = calculateDiscount(player);
    const required = {};
    let totalRequired = 0;

    ALL_COLORS.forEach((color) => {
      required[color] = Math.max(0, cost[color] - (discount[color] || 0));
      if (color !== "purple") totalRequired += required[color];
    });

    const payCost = {};
    let purpleNeeded = 0;

    NORMAL_COLORS.forEach((color) => {
      const canPay = Math.min(required[color], player.tokens[color] || 0);
      payCost[color] = canPay;
      if (canPay < required[color]) {
        purpleNeeded += required[color] - canPay;
      }
    });

    payCost.purple = required.purple + purpleNeeded;

    if (payCost.purple > (player.tokens.purple || 0)) return null;

    let valid = true;
    ALL_COLORS.forEach((color) => {
      if ((payCost[color] || 0) > (player.tokens[color] || 0)) valid = false;
    });
    if (!valid) return null;

    return payCost;
  }

  function canBuy(player, card) {
    return calculatePayCost(player, card) !== null;
  }

  function getPayInfo(player, card) {
    const cost = normalizeTokens(card.cost);
    const discount = calculateDiscount(player);
    const requiredAfterDiscount = {};
    ALL_COLORS.forEach((color) => {
      requiredAfterDiscount[color] = Math.max(0, cost[color] - (discount[color] || 0));
    });
    const payCost = calculatePayCost(player, card);
    // v0.9.5.4 修复：必须返回 payable 字段，否则 renderSelectedInfo 中 info.payable 恒为 undefined，
    // 导致即使玩家 token 足够，selected-card-panel 仍错误显示"token 不足"且捕捉按钮被禁用。
    return { cost, discount, requiredAfterDiscount, payCost, payable: payCost !== null };
  }

  // v0.9.5.4 联机模式 selected-card-panel / buySelectedCard 等需要判断"本地能否行动"时使用的统一辅助函数
  // 单机模式：返回 currentPlayer()（当前行动玩家）
  // 联机模式：若不是本地玩家回合，返回 null（不允许操作）；若为本地玩家回合，返回 currentPlayer()
  // 这样 renderSelectedInfo 内部能正确区分"不是我的回合"与"token 不足"两种不同状态
  function getActionPlayerForUI() {
    if (!gameState) return null;
    if (onlineMode) {
      if (!isOnlineLocalTurn()) return null;
      return gameState.players[gameState.currentPlayerIndex] || null;
    }
    return currentPlayer();
  }

  function canEvolve(player, baseCard, targetCard) {
    if (!baseCard || !targetCard) return false;
    if (!baseCard.evolvesTo) return false;
    if (baseCard.evolvesTo !== targetCard.name_zh) return false;
    const evolveCost = normalizeTokens(baseCard.evolveCost);
    const discount = calculateDiscount(player);
    return NORMAL_COLORS.every((color) => {
      return (discount[color] || 0) >= (evolveCost[color] || 0);
    });
  }

  function getEvolveOptions(player) {
    const options = [];
    player.tableau.forEach((baseCard) => {
      if (!baseCard.evolvesTo) return;
      MARKET_KEYS.forEach((key) => {
        gameState.market[key].forEach((targetCard, index) => {
          if (targetCard.name_zh === baseCard.evolvesTo && canEvolve(player, baseCard, targetCard)) {
            options.push({ baseCard, targetCard, source: "market", marketKey: key, index });
          }
        });
      });
      player.reserved.forEach((targetCard, index) => {
        if (targetCard.name_zh === baseCard.evolvesTo && canEvolve(player, baseCard, targetCard)) {
          options.push({ baseCard, targetCard, source: "reserved", index });
        }
      });
    });
    return options;
  }

  function findEvolutionTarget(player, targetCardId) {
    for (const key of MARKET_KEYS) {
      const index = gameState.market[key].findIndex((card) => card.id === targetCardId);
      if (index >= 0) {
        return { source: "market", marketKey: key, index, card: gameState.market[key][index] };
      }
    }
    const resIndex = player.reserved.findIndex((card) => card.id === targetCardId);
    if (resIndex >= 0) {
      return { source: "reserved", index: resIndex, card: player.reserved[resIndex] };
    }
    return null;
  }

  function performTakeDifferentTokens(playerIndex, colors, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "takeDifferent", colors: [...(colors || [])] }); return false; }
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      if (!options.silent) notify("当前不能执行主要行动。", "error");
      return false;
    }
    const player = gameState.players[playerIndex];
    if (!player) return false;

    // 1. 基础校验：必须是数组，长度必须为 3
    if (!Array.isArray(colors) || colors.length !== 3) {
      if (!options.silent) notify("拿不同球时必须拿 3 个球。", "error");
      return false;
    }

    // 2. 不能包含 purple
    if (colors.some((color) => !NORMAL_COLORS.includes(color))) {
      if (!options.silent) notify("只能拿普通球，不能拿大师球。", "error");
      return false;
    }

    // 3. 统计每种颜色拿取数量
    const countMap = {};
    colors.forEach((color) => { countMap[color] = (countMap[color] || 0) + 1; });
    const usedColors = Object.keys(countMap);

    // 4. 每种颜色拿取数量不能超过供应区
    const availableColors = NORMAL_COLORS.filter((color) => gameState.supply[color] > 0);
    for (const color of usedColors) {
      if ((gameState.supply[color] || 0) < countMap[color]) {
        if (!options.silent) notify(`${TOKEN_LABELS[color]} 供应不足。`, "error");
        return false;
      }
    }

    // 5. PDF 规则校验
    if (availableColors.length >= 3) {
      // >= 3 种可用：必须 3 种不同颜色，各 1 个
      if (usedColors.length !== 3) {
        if (!options.silent) notify("供应区至少有 3 种普通球时，必须拿 3 种不同普通球，各 1 个。", "error");
        return false;
      }
      if (usedColors.some((color) => countMap[color] !== 1)) {
        if (!options.silent) notify("供应区至少有 3 种普通球时，每种只能拿 1 个。", "error");
        return false;
      }
    } else if (availableColors.length === 2) {
      // 2 种可用：拿 3 个球，2+1 分配
      if (usedColors.length !== 2) {
        if (!options.silent) notify("供应区只有 2 种普通球时，必须拿这 2 种颜色，其中一种拿 2 个，另一种拿 1 个。", "error");
        return false;
      }
      if (!usedColors.every((color) => availableColors.includes(color))) {
        if (!options.silent) notify("只能使用供应区中可用的颜色。", "error");
        return false;
      }
      const counts = Object.values(countMap);
      if (counts.length !== 2 || !counts.includes(2) || !counts.includes(1)) {
        if (!options.silent) notify("供应区只有 2 种普通球时，必须一种拿 2 个，另一种拿 1 个。", "error");
        return false;
      }
    } else {
      // <= 1 种可用：不能执行此行动
      if (!options.silent) notify("可用普通球不足 2 种，不能执行此行动。", "error");
      return false;
    }

    // 6. 执行：按 colors 中每个颜色出现次数扣除和增加
    colors.forEach((color) => {
      gameState.supply[color] -= 1;
      player.tokens[color] += 1;
    });

    const colorNames = {};
    usedColors.forEach((color) => { colorNames[color] = TOKEN_LABELS[color]; });
    const msgParts = usedColors.map((color) => `${colorNames[color]} ×${countMap[color]}`).join("、");
    const msg = `${player.name} 拿取了 ${msgParts}。`;
    if (options.log !== false) addActionLog(msg);
    completeMainAction(msg);
    return true;
  }

  function performTakeTwoSameTokens(playerIndex, color, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "takeSame", color }); return false; }
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      if (!options.silent) notify("当前不能执行主要行动。", "error");
      return false;
    }
    const player = gameState.players[playerIndex];
    if (!player) return false;
    if (!NORMAL_COLORS.includes(color)) {
      if (!options.silent) notify("只能选择普通球。", "error");
      return false;
    }
    if (gameState.supply[color] < 4) {
      if (!options.silent) notify(`${TOKEN_LABELS[color]} 在拿取前至少需要有 4 个。`, "error");
      return false;
    }
    gameState.supply[color] -= 2;
    player.tokens[color] += 2;
    const msg = `${player.name} 拿取了 2 个${TOKEN_LABELS[color]}。`;
    if (options.log !== false) addActionLog(msg);
    completeMainAction(msg);
    return true;
  }

  function performReserveMarketCard(playerIndex, marketKey, cardId, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "reserveMarket", marketKey, cardId }); return false; }
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      if (!options.silent) notify("当前不能执行主要行动。", "error");
      return false;
    }
    const player = gameState.players[playerIndex];
    if (!player) return false;
    if (player.reserved.length >= 3) {
      if (!options.silent) notify("每名玩家最多保留 3 张卡。", "error");
      return false;
    }
    if (!["level1", "level2", "level3"].includes(marketKey)) {
      if (!options.silent) notify("稀有和传说卡不能保留。", "error");
      return false;
    }
    const index = gameState.market[marketKey].findIndex((card) => card.id === cardId);
    if (index < 0) {
      if (!options.silent) notify("目标卡不在公共区。", "error");
      return false;
    }
    const [card] = gameState.market[marketKey].splice(index, 1);
    player.reserved.push(card);
    if (gameState.supply.purple > 0) {
      gameState.supply.purple -= 1;
      player.tokens.purple += 1;
    }
    drawToMarket(marketKey);
    gameState.selectedCard = null;
    const msg = `${player.name} 保留了 ${getCardName(card)}。`;
    if (options.log !== false) addActionLog(msg);
    completeMainAction(msg);
    return true;
  }

  function performReserveDeckTop(playerIndex, deckKey, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "reserveDeckTop", deckKey }); return false; }
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      if (!options.silent) notify("当前不能执行主要行动。", "error");
      return false;
    }
    const player = gameState.players[playerIndex];
    if (!player) return false;
    if (player.reserved.length >= 3) {
      if (!options.silent) notify("每名玩家最多保留 3 张卡。", "error");
      return false;
    }
    if (!["level1", "level2", "level3"].includes(deckKey)) {
      if (!options.silent) notify("只能从 1/2/3 级牌堆顶保留。", "error");
      return false;
    }
    if (!gameState.decks[deckKey].length) {
      if (!options.silent) notify(`${MARKET_LABELS[deckKey]}牌堆已经没有牌。`, "error");
      return false;
    }
    const card = gameState.decks[deckKey].pop();
    player.reserved.push(card);
    if (gameState.supply.purple > 0) {
      gameState.supply.purple -= 1;
      player.tokens.purple += 1;
    }
    const msg = `${player.name} 从牌堆顶保留了 1 张${MARKET_LABELS[deckKey]}卡。`;
    if (options.log !== false) addActionLog(msg);
    completeMainAction(msg);
    return true;
  }

  function performBuyCard(playerIndex, source, cardId, options = {}) {
    if (onlineMode && !options.localOnly) {
      const sc = gameState?.selectedCard;
      submitOnlineAction({ type: "buy", source, cardId, marketKey: sc?.marketKey || "" });
      return false;
    }
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) {
      if (!options.silent) notify("当前不能执行主要行动。", "error");
      return false;
    }
    const player = gameState.players[playerIndex];
    if (!player) return false;

    let ref = null;
    if (source === "market") {
      for (const key of MARKET_KEYS) {
        const index = gameState.market[key].findIndex((card) => card.id === cardId);
        if (index >= 0) { ref = { source: "market", marketKey: key, index, card: gameState.market[key][index] }; break; }
      }
    } else if (source === "reserved") {
      const index = player.reserved.findIndex((card) => card.id === cardId);
      if (index >= 0) { ref = { source: "reserved", index, card: player.reserved[index], marketKey: "" }; }
    }
    if (!ref) {
      if (!options.silent) notify("没有找到可捕捉的目标卡。", "error");
      return false;
    }

    const payCost = calculatePayCost(player, ref.card);
    if (!payCost) {
      if (!options.silent) notify("token 不足，无法捕捉这张卡。", "error");
      return false;
    }

    ALL_COLORS.forEach((color) => {
      player.tokens[color] -= payCost[color];
      gameState.supply[color] += payCost[color];
    });
    if (ref.source === "market") {
      gameState.market[ref.marketKey].splice(ref.index, 1);
      drawToMarket(ref.marketKey);
    } else {
      player.reserved.splice(ref.index, 1);
    }
    player.tableau.push(ref.card);
    updatePlayerScore(player);
    gameState.selectedCard = null;

    const msg = `${player.name} 捕捉了 ${getCardName(ref.card)}。`;
    if (options.log !== false) addActionLog(msg);
    completeMainAction(msg);
    return true;
  }

  function performEvolve(playerIndex, baseCardId, targetCardId, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "evolve", baseCardId, targetCardId }); return false; }
    if (!gameState) return false;
    const player = gameState.players[playerIndex];
    if (!player) return false;
    if (gameState.phase !== "evolve") {
      if (!options.silent) notify("当前不在进化阶段。", "error");
      return false;
    }
    if (gameState.didEvolveThisTurn) {
      if (!options.silent) notify("每回合最多进化 1 次。", "error");
      return false;
    }
    const baseIndex = player.tableau.findIndex((card) => card.id === baseCardId);
    const baseCard = player.tableau[baseIndex];
    const targetRef = findEvolutionTarget(player, targetCardId);
    if (baseIndex < 0 || !targetRef || !canEvolve(player, baseCard, targetRef.card)) {
      if (!options.silent) notify("不满足进化条件。", "error");
      return false;
    }

    player.tableau.splice(baseIndex, 1);
    player.evolvedArchive.push(baseCard);
    if (targetRef.source === "market") {
      gameState.market[targetRef.marketKey].splice(targetRef.index, 1);
      drawToMarket(targetRef.marketKey);
    } else {
      player.reserved.splice(targetRef.index, 1);
    }
    player.tableau.push(targetRef.card);
    updatePlayerScore(player);
    gameState.didEvolveThisTurn = true;
    gameState.selectedCard = null;
    const msg = `${player.name} 将 ${getCardName(baseCard)} 进化为 ${getCardName(targetRef.card)}。`;
    if (options.log !== false) addActionLog(msg);
    notify(msg, "info");
    saveGame();
    return true;
  }

  function performDiscardToken(playerIndex, color, options = {}) {
    if (onlineMode && !options.localOnly) { submitOnlineAction({ type: "discard", color }); return false; }
    if (!gameState || gameState.phase !== "discard") return false;
    const player = gameState.players[playerIndex];
    if (!player) return false;
    if (!ALL_COLORS.includes(color) || (player.tokens[color] || 0) <= 0) {
      if (!options.silent) notify("不能丢弃这个 token。", "error");
      return false;
    }
    player.tokens[color] -= 1;
    gameState.supply[color] += 1;
    if (totalTokens(player.tokens) <= 10) {
      gameState.phase = "evolve";
      notify("token 已降到 10 个以内，可以选择进化或结束回合。", "info");
    }
    saveGame();
    render();
    return true;
  }

  function checkSpectatorAutoTurnLimit() {
    if (!gameState?.spectatorMode || gameState.turnNumber <= MAX_AUTO_TURNS) return false;
    const msg = "AI 对战达到最大自动回合数，进入停滞结算。";
    addActionLog(msg);
    notify(msg, "warn");
    finishGameByStalemate();
    return true;
  }

  function performEndTurn(options = {}) {
    if (onlineMode && !options.localOnly) return false;
    if (!options.skipHistory) pushHistorySnapshot();
    if (checkSpectatorAutoTurnLimit()) return;
    const player = currentPlayer();
    let endMessage = "";
    updatePlayerScore(player);
    gameState.playerTurns[gameState.currentPlayerIndex] += 1;

    if (!gameState.finalRoundTriggered && player.score >= 18) {
      gameState.finalRoundTriggered = true;
      gameState.finalTriggerPlayerIndex = gameState.currentPlayerIndex;
      gameState.finalTargetTurnCount = gameState.playerTurns[gameState.currentPlayerIndex];
      endMessage = `${player.name} 达到 18 分，触发最终轮。`;
      gameState.lastMessage = endMessage;
    }

    if (gameState.finalRoundTriggered && gameState.playerTurns.every((turns) => turns >= gameState.finalTargetTurnCount)) {
      finishGame();
      return;
    }

    gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.playerCount;
    if (gameState.currentPlayerIndex === 0) gameState.turnNumber += 1;
    if (checkSpectatorAutoTurnLimit()) return;
    gameState.phase = "awaitAction";
    gameState.mainActionDone = false;
    gameState.didEvolveThisTurn = false;
    gameState.selectedCard = null;
    notify(`${endMessage ? `${endMessage} ` : ""}轮到 ${currentPlayer().name}。`, "info");
    saveGame();
    render();
  }

  // =============================
  // Legal action generator and MCTS simulation
  // =============================
  function refillMarketInState(state, key) {
    const targetSize = marketSize(key);
    while (state.market[key].length < targetSize && state.decks[key].length > 0) {
      state.market[key].push(state.decks[key].pop());
    }
  }

  function updatePlayerScoreInState(player) {
    player.score = sumPoints(player.tableau || []);
  }

  function calculateDiscountInState(state, player) {
    const discount = emptyTokens();
    (player?.tableau || []).forEach((card) => {
      if (card.bonus && card.bonus.color && card.bonus.count) {
        discount[card.bonus.color] = (discount[card.bonus.color] || 0) + card.bonus.count;
      }
    });
    return discount;
  }

  function calculatePayCostInState(state, player, card) {
    const cost = normalizeTokens(card?.cost);
    const discount = calculateDiscountInState(state, player);
    const required = {};
    let purpleNeeded = 0;
    const payCost = {};

    ALL_COLORS.forEach((color) => {
      required[color] = Math.max(0, cost[color] - (discount[color] || 0));
    });

    NORMAL_COLORS.forEach((color) => {
      const canPay = Math.min(required[color], player.tokens[color] || 0);
      payCost[color] = canPay;
      if (canPay < required[color]) {
        purpleNeeded += required[color] - canPay;
      }
    });

    payCost.purple = required.purple + purpleNeeded;
    if (payCost.purple > (player.tokens.purple || 0)) return null;

    let valid = true;
    ALL_COLORS.forEach((color) => {
      if ((payCost[color] || 0) > (player.tokens[color] || 0)) valid = false;
    });
    return valid ? payCost : null;
  }

  function canBuyInState(state, player, card) {
    return calculatePayCostInState(state, player, card) !== null;
  }

  function getCombinations(items, size) {
    const result = [];
    function walk(start, chosen) {
      if (chosen.length === size) {
        result.push(chosen.slice());
        return;
      }
      for (let i = start; i < items.length; i++) {
        chosen.push(items[i]);
        walk(i + 1, chosen);
        chosen.pop();
      }
    }
    walk(0, []);
    return result;
  }

  function getLegalTakeDifferentTokenActionsFromSupply(supply) {
    const safeSupply = supply || {};
    const availableColors = NORMAL_COLORS.filter((color) => (safeSupply[color] || 0) > 0);

    if (availableColors.length >= 3) {
      return getCombinations(availableColors, 3).map((colors) => ({ type: "takeDifferent", colors }));
    }

    if (availableColors.length !== 2) return [];

    const [a, b] = availableColors;
    const actions = [];
    if ((safeSupply[a] || 0) >= 2 && (safeSupply[b] || 0) >= 1) {
      actions.push({ type: "takeDifferent", colors: [a, a, b] });
    }
    if ((safeSupply[a] || 0) >= 1 && (safeSupply[b] || 0) >= 2) {
      actions.push({ type: "takeDifferent", colors: [a, b, b] });
    }
    return actions;
  }

  function getGameStage(player) {
    const score = player?.score || 0;
    const tableauCount = player?.tableau?.length || 0;
    const discount = calculateDiscount(player);
    const discountTotal = NORMAL_COLORS.reduce((sum, c) => sum + (discount[c] || 0), 0);

    if (score >= 12 || tableauCount >= 8) return "late";
    if (score >= 5 || tableauCount >= 4 || discountTotal >= 5) return "mid";
    return "early";
  }

  function getPlayerIndexInState(state, player) {
    if (!state || !player) return -1;
    const directIndex = state.players.indexOf(player);
    if (directIndex >= 0) return directIndex;
    if (typeof player.id === "string") return state.players.findIndex((p) => p.id === player.id);
    return -1;
  }

  function getVisibleCardRefsInState(state, player) {
    const refs = [];
    (player?.reserved || []).forEach((card, index) => {
      refs.push({ card, source: "reserved", index });
    });
    MARKET_KEYS.forEach((marketKey) => {
      (state?.market?.[marketKey] || []).forEach((card, index) => {
        refs.push({ card, source: "market", marketKey, index });
      });
    });
    return refs;
  }

  function isEvolutionTargetForPlayer(player, card) {
    if (!player || !card) return false;
    return (player.tableau || []).some((baseCard) => baseCard.evolvesTo && baseCard.evolvesTo === card.name_zh);
  }

  function isMiddleEvolutionTargetForPlayer(player, card) {
    return isEvolutionTargetForPlayer(player, card) && Boolean(card?.evolvesTo);
  }

  function isHighValueFinalCard(card) {
    if (!card) return false;
    return card.category === "rare"
      || card.category === "legend"
      || (card.level || 0) >= 3
      || (!card.evolvesTo && (card.points || 0) >= 3);
  }

  function getShortageForCardInState(state, player, card) {
    const cost = normalizeTokens(card?.cost);
    const discount = calculateDiscountInState(state, player);
    const required = emptyTokens();
    const missing = emptyTokens();
    let normalMissingTotal = 0;

    NORMAL_COLORS.forEach((color) => {
      required[color] = Math.max(0, (cost[color] || 0) - (discount[color] || 0));
      missing[color] = Math.max(0, required[color] - (player?.tokens?.[color] || 0));
      normalMissingTotal += missing[color];
    });

    required.purple = Math.max(0, cost.purple || 0);
    missing.purple = Math.max(0, required.purple - (player?.tokens?.purple || 0));

    const purpleAvailableForNormal = Math.max(0, (player?.tokens?.purple || 0) - required.purple);
    const totalAfterPurple = Math.max(0, normalMissingTotal - purpleAvailableForNormal) + missing.purple;
    const requiredTotal = NORMAL_COLORS.reduce((sum, color) => sum + required[color], required.purple);

    return {
      cost,
      discount,
      required,
      missing,
      normalMissingTotal,
      totalAfterPurple,
      requiredTotal
    };
  }

  function estimateTurnsToBuyInState(state, player, card) {
    const shortage = getShortageForCardInState(state, player, card);
    if (canBuyInState(state, player, card)) return 0;
    return Math.ceil(shortage.totalAfterPurple / 3);
  }

  function getUsefulColorDemandInState(state, player, color) {
    let demand = 0;
    getVisibleCardRefsInState(state, player).forEach((ref) => {
      const shortage = getShortageForCardInState(state, player, ref.card);
      const missing = shortage.missing[color] || 0;
      if (!missing) return;
      const weight = 1 + Math.min(3, Number(ref.card.points) || 0) + (isEvolutionTargetForPlayer(player, ref.card) ? 2 : 0);
      demand += missing * weight;
    });
    return demand;
  }

  function getUsefulDiscountValueInState(state, player, color, count = 1) {
    if (!NORMAL_COLORS.includes(color) || !count) return 0;
    const demand = getUsefulColorDemandInState(state, player, color);
    return count * (1 + Math.min(4, demand));
  }

  function evaluateCardForAIInState(state, player, card) {
    if (!state || !player || !card) return -Infinity;
    const stage = getGameStage(player);
    const points = Number(card.points) || 0;
    const pointMultiplier = stage === "early" ? 8 : stage === "mid" ? 14 : 24;
    const bonusMultiplier = stage === "early" ? 12 : stage === "mid" ? 8 : 4;
    const shortage = getShortageForCardInState(state, player, card);
    const rawCostTotal = totalTokens(shortage.cost);
    const effectiveCostTotal = NORMAL_COLORS.reduce((sum, color) => sum + shortage.required[color], shortage.required.purple);

    let value = points * pointMultiplier;

    if (card.bonus?.color) {
      value += (Number(card.bonus.count) || 0) * bonusMultiplier;
      value += getUsefulDiscountValueInState(state, player, card.bonus.color, card.bonus.count) * 2;
    }

    if (card.evolvesTo) value += 10;
    if (isEvolutionTargetForPlayer(player, card)) value += 18;
    if (isMiddleEvolutionTargetForPlayer(player, card)) value += 20;
    if (isHighValueFinalCard(card)) value += points * 5;

    if (card.category === "rare") {
      if (stage === "early") value += 8;
      else if (stage === "mid") value += 28;
      else value += 55;
      value += points * 12;
      if (card.bonus && (Number(card.bonus.count) || 0) >= 2) value += 20;
      if ((player.score || 0) + points >= 18) value += 120;
      else if ((player.score || 0) + points >= 15) value += 45;
    }

    if (card.category === "legend") {
      if (stage === "early") value += 10;
      else if (stage === "mid") value += 40;
      else value += 85;
      value += points * 16;
      if (card.bonus && (Number(card.bonus.count) || 0) >= 2) value += 28;
      if ((player.score || 0) + points >= 18) value += 160;
      else if ((player.score || 0) + points >= 15) value += 60;
    }

    // purple 大师球影响
    if (shortage.cost?.purple > 0) {
      const playerPurple = (player.tokens?.purple || 0);
      if (playerPurple >= (shortage.cost.purple || 0)) {
        value += 20;
      } else {
        if (stage === "early") value -= 25;
        else if (stage === "mid") value -= 12;
        else value += Math.max(0, points * 6 - 12);
      }
    }

    // early 阶段限制：买不起的 rare/legend 大幅降分
    if (stage === "early" && (card.category === "rare" || card.category === "legend")) {
      const canBuy = !!calculatePayCostInState(state, player, card);
      if (!canBuy) {
        value -= card.category === "legend" ? 55 : 35;
        value -= (shortage.totalAfterPurple || 0) * 8;
      }
    }

    // early 阶段 level1 提升优先级
    if (stage === "early" && card.level === 1 && card.category === "normal") {
      value += 35;
    }

    const turnsToBuy = estimateTurnsToBuyInState(state, player, card);
    if (turnsToBuy <= 1) value += 18;
    else if (turnsToBuy <= 2) value += 10;
    else value -= Math.min(18, turnsToBuy * 3);

    const costPenalty = effectiveCostTotal * (stage === "early" ? 1.4 : stage === "mid" ? 1.0 : 0.7) + rawCostTotal * 0.25;
    value -= costPenalty;

    return value;
  }

  function evaluateCardForAI(player, card) {
    return evaluateCardForAIInState(gameState, player, card);
  }

  function chooseAITargetCardInState(state, player) {
    if (!state || !player) return null;
    const stage = getGameStage(player);
    const allRefs = getVisibleCardRefsInState(state, player);
    if (!allRefs.length) return null;

    // 按阶段过滤目标池
    let refs = allRefs;
    if (stage === "early") {
      refs = allRefs.filter((ref) => {
        const card = ref.card;
        const canBuy = !!calculatePayCostInState(state, player, card);
        const shortage = getShortageForCardInState(state, player, card);
        if (card.category === "rare" || card.category === "legend") return canBuy;
        if (card.level === 1) return true;
        if (card.level === 2) return (shortage.totalAfterPurple || 99) <= 2;
        if (card.level === 3) return canBuy;
        return false;
      });
      if (!refs.length) refs = allRefs;
    } else if (stage === "mid") {
      refs = allRefs.filter((ref) => {
        const card = ref.card;
        if (card.category === "legend") {
          const canBuy = !!calculatePayCostInState(state, player, card);
          const shortage = getShortageForCardInState(state, player, card);
          return canBuy || (shortage.totalAfterPurple || 99) <= 3;
        }
        return true;
      });
      if (!refs.length) refs = allRefs;
    }

    const candidates = refs.map((ref) => {
      const turnsToBuy = estimateTurnsToBuyInState(state, player, ref.card);
      let value = evaluateCardForAIInState(state, player, ref.card);

      if (turnsToBuy <= 1) value += 35;
      else if (turnsToBuy <= 2) value += 22;
      else if (turnsToBuy <= 3) value += 8;
      else value -= Math.min(24, turnsToBuy * 4);

      if (isEvolutionTargetForPlayer(player, ref.card)) value += 30;

      if (stage === "early") {
        if (ref.card.category === "normal" && (ref.card.level || 0) === 1 && ref.card.bonus?.color) value += 20;
        if ((ref.card.level || 0) >= 3) value -= 18;
      } else if (stage === "mid") {
        if (isEvolutionTargetForPlayer(player, ref.card) || ref.card.evolvesTo) value += 14;
        value += Math.min(12, (Number(ref.card.points) || 0) * 3);
      } else {
        if (isHighValueFinalCard(ref.card)) value += 24;
        if (ref.card.category === "rare") value += 28;
        if (ref.card.category === "legend") value += 38;
      }

      if (ref.source === "reserved") value += 6;

      return {
        ...ref,
        value,
        turnsToBuy,
        shortage: getShortageForCardInState(state, player, ref.card)
      };
    });

    candidates.sort((a, b) => b.value - a.value);
    return candidates[0] || null;
  }

  function chooseAITargetCard(player) {
    return chooseAITargetCardInState(gameState, player);
  }

  function formatTokenListForAction(action) {
    const countMap = {};
    if (action.type === "takeDifferent") {
      (action.colors || []).forEach((color) => { countMap[color] = (countMap[color] || 0) + 1; });
    } else if (action.type === "takeSame") {
      countMap[action.color] = 2;
    }
    return Object.keys(countMap)
      .map((color) => `${TOKEN_LABELS[color]}×${countMap[color]}`)
      .join("、");
  }

  function getTokenColorsForAction(action) {
    if (action.type === "takeDifferent") return action.colors || [];
    if (action.type === "takeSame") return [action.color, action.color];
    return [];
  }

  function scoreTokenActionForAIInState(state, player, action, targetRef = null) {
    if (!state || !player || !action) return -Infinity;
    const colors = getTokenColorsForAction(action);
    if (!colors.length) return -Infinity;

    const target = targetRef?.card ? targetRef : chooseAITargetCardInState(state, player);
    const before = target?.card ? getShortageForCardInState(state, player, target.card) : null;
    const afterPlayer = clone(player);
    colors.forEach((color) => { afterPlayer.tokens[color] = (afterPlayer.tokens[color] || 0) + 1; });
    const after = target?.card ? getShortageForCardInState(state, afterPlayer, target.card) : null;

    let value = 0;
    if (before && after) {
      const reduced = Math.max(0, before.totalAfterPurple - after.totalAfterPurple);
      value += reduced * 12;
      if (after.totalAfterPurple === 0 && before.totalAfterPurple > 0) value += 18;
    }

    colors.forEach((color) => {
      const needed = before ? (before.missing[color] || 0) : 0;
      if (needed > 0) {
        value += 4;
      } else {
        value -= 4;
        if (getUsefulColorDemandInState(state, player, color) > 0) value += 2;
      }
    });

    const overflow = Math.max(0, totalTokens(afterPlayer.tokens) - 10);
    value -= overflow * 8;
    if (action.type === "takeSame") value += 2;
    return value;
  }

  function getOpponentPressureForCardInState(state, playerIndex, card) {
    if (!state || !card) return 0;
    let pressure = 0;
    (state.players || []).forEach((other, index) => {
      if (index === playerIndex) return;
      if (canBuyInState(state, other, card)) pressure = Math.max(pressure, 10);
      else if (estimateTurnsToBuyInState(state, other, card) <= 1) pressure = Math.max(pressure, 6);
    });
    return pressure;
  }

  function scoreReserveCardForAIInState(state, playerIndex, ref) {
    const player = state?.players?.[playerIndex];
    if (!player || !ref?.card || (player.reserved || []).length >= 3) return -Infinity;
    if (!["level1", "level2", "level3"].includes(ref.marketKey)) return -Infinity;

    const stage = getGameStage(player);
    let value = evaluateCardForAIInState(state, player, ref.card) * 0.5;
    if (isEvolutionTargetForPlayer(player, ref.card)) value += 30;
    if (isHighValueFinalCard(ref.card)) value += 20;
    value += getOpponentPressureForCardInState(state, playerIndex, ref.card);

    // 保留惩罚：early 阶段大幅惩罚
    let reservePenalty = 0;
    if (stage === "early") reservePenalty += 35;
    if ((player.reserved || []).length >= 1 && stage === "early") reservePenalty += 25;
    if ((player.reserved || []).length >= 2) reservePenalty += 50;
    if ((ref.card.level || 1) >= 2 && stage === "early") reservePenalty += 20;
    // early 阶段 tableau 空 且 reserved>=1 时额外惩罚
    if (stage === "early" && (player.tableau || []).length === 0 && (player.reserved || []).length >= 1) reservePenalty += 30;
    value -= reservePenalty;

    // 为获得大师球而保留的适度加分
    const hasSpecialNeedingPurple = getVisibleCardRefsInState(state, player).some((ref) =>
      (ref.card.category === "rare" || ref.card.category === "legend") && (ref.card.cost?.purple || 0) > 0
    );
    if (hasSpecialNeedingPurple && state.supply?.purple > 0) {
      if ((player.reserved || []).length < 2) value += 18;
      else value += 5;
    }

    value -= (player.reserved || []).length * 12;
    return value;
  }

  function scoreEvolutionOptionForAIInState(state, player, option) {
    if (!state || !player || !option) return -Infinity;
    const scoreGain = (Number(option.targetCard.points) || 0) - (Number(option.baseCard.points) || 0);
    let value = scoreGain * 18;

    if (option.targetCard.bonus?.color) {
      const count = Number(option.targetCard.bonus.count) || 0;
      value += count * (getGameStage(player) === "early" ? 10 : 7);
      value += getUsefulDiscountValueInState(state, player, option.targetCard.bonus.color, count) * 2;
    }
    if (option.targetCard.evolvesTo) value += 12;
    if ((player.score || 0) + scoreGain >= 18) value += 60;

    const targetBefore = chooseAITargetCardInState(state, player);
    if (targetBefore?.card) {
      const before = getShortageForCardInState(state, player, targetBefore.card).totalAfterPurple;
      const simPlayer = clone(player);
      const baseIndex = simPlayer.tableau.findIndex((card) => card.id === option.baseCard.id);
      if (baseIndex >= 0) {
        simPlayer.tableau.splice(baseIndex, 1);
        simPlayer.tableau.push(option.targetCard);
        const after = getShortageForCardInState(state, simPlayer, targetBefore.card).totalAfterPurple;
        if (after > before) value -= (after - before) * 8;
        if (after < before) value += (before - after) * 5;
      }
    }

    return value;
  }

  function generateLegalActions(playerIndex, state = gameState) {
    const actions = [];
    const player = state?.players?.[playerIndex];
    if (!state || !player || state.gameOver || state.phase !== "awaitAction") return actions;

    (player.reserved || []).forEach((card) => {
      if (canBuyInState(state, player, card)) {
        actions.push({ type: "buy", source: "reserved", cardId: card.id });
      }
    });

    MARKET_KEYS.forEach((marketKey) => {
      (state.market[marketKey] || []).forEach((card) => {
        if (canBuyInState(state, player, card)) {
          actions.push({ type: "buy", source: "market", marketKey, cardId: card.id });
        }
      });
    });

    actions.push(...getLegalTakeDifferentTokenActionsFromSupply(state.supply));

    NORMAL_COLORS.forEach((color) => {
      if ((state.supply[color] || 0) >= 4) {
        actions.push({ type: "takeSame", color });
      }
    });

    if ((player.reserved || []).length < 3) {
      ["level1", "level2", "level3"].forEach((marketKey) => {
        (state.market[marketKey] || []).forEach((card) => {
          actions.push({ type: "reserveMarket", marketKey, cardId: card.id });
        });
        if ((state.decks[marketKey] || []).length > 0) {
          actions.push({ type: "reserveDeckTop", deckKey: marketKey });
        }
      });
    }

    return actions;
  }

  function findMarketCardInState(state, marketKey, cardId) {
    const market = state.market?.[marketKey] || [];
    const index = market.findIndex((card) => card.id === cardId);
    return index >= 0 ? { index, card: market[index] } : null;
  }

  function findBuyTargetInState(state, player, action) {
    if (action.source === "reserved") {
      const index = (player.reserved || []).findIndex((card) => card.id === action.cardId);
      return index >= 0 ? { source: "reserved", index, card: player.reserved[index] } : null;
    }
    if (action.source === "market") {
      const ref = findMarketCardInState(state, action.marketKey, action.cardId);
      return ref ? { source: "market", marketKey: action.marketKey, ...ref } : null;
    }
    return null;
  }

  function discardDownToLimitInState(state, player) {
    while (totalTokens(player.tokens) > 10) {
      const color = NORMAL_COLORS
        .slice()
        .sort((a, b) => (player.tokens[b] || 0) - (player.tokens[a] || 0))
        .find((c) => (player.tokens[c] || 0) > 0) || ((player.tokens.purple || 0) > 0 ? "purple" : null);
      if (!color) break;
      player.tokens[color] -= 1;
      state.supply[color] += 1;
    }
  }

  function canEvolveInState(state, player, baseCard, targetCard) {
    if (!baseCard || !targetCard) return false;
    if (!baseCard.evolvesTo) return false;
    if (baseCard.evolvesTo !== targetCard.name_zh) return false;
    const evolveCost = normalizeTokens(baseCard.evolveCost);
    const discount = calculateDiscountInState(state, player);
    return NORMAL_COLORS.every((color) => (discount[color] || 0) >= (evolveCost[color] || 0));
  }

  function getEvolveOptionsInState(state, playerIndex) {
    const player = state.players[playerIndex];
    const options = [];
    if (!player || state.didEvolveThisTurn) return options;

    (player.tableau || []).forEach((baseCard) => {
      if (!baseCard.evolvesTo) return;
      MARKET_KEYS.forEach((marketKey) => {
        (state.market[marketKey] || []).forEach((targetCard, index) => {
          if (targetCard.name_zh === baseCard.evolvesTo && canEvolveInState(state, player, baseCard, targetCard)) {
            options.push({ baseCard, targetCard, source: "market", marketKey, index });
          }
        });
      });
      (player.reserved || []).forEach((targetCard, index) => {
        if (targetCard.name_zh === baseCard.evolvesTo && canEvolveInState(state, player, baseCard, targetCard)) {
          options.push({ baseCard, targetCard, source: "reserved", index });
        }
      });
    });
    return options;
  }

  function applyBestEvolutionInState(state, playerIndex) {
    const player = state.players[playerIndex];
    const options = getEvolveOptionsInState(state, playerIndex);
    if (!player || !options.length) return false;

    options.sort((a, b) => scoreEvolutionOptionForAIInState(state, player, b) - scoreEvolutionOptionForAIInState(state, player, a));

    const best = options[0];
    if (scoreEvolutionOptionForAIInState(state, player, best) <= 0) return false;

    const baseIndex = player.tableau.findIndex((card) => card.id === best.baseCard.id);
    if (baseIndex < 0) return false;
    const [baseCard] = player.tableau.splice(baseIndex, 1);
    player.evolvedArchive.push(baseCard);

    if (best.source === "market") {
      state.market[best.marketKey].splice(best.index, 1);
      refillMarketInState(state, best.marketKey);
    } else {
      player.reserved.splice(best.index, 1);
    }

    player.tableau.push(best.targetCard);
    state.didEvolveThisTurn = true;
    updatePlayerScoreInState(player);
    return true;
  }

  function advanceTurnInState(state) {
    const player = state.players[state.currentPlayerIndex];
    if (!player) {
      state.gameOver = true;
      state.stalemate = true;
      state.phase = "gameOver";
      return;
    }

    updatePlayerScoreInState(player);
    state.playerTurns[state.currentPlayerIndex] = (state.playerTurns[state.currentPlayerIndex] || 0) + 1;

    if ((player.score || 0) >= 18) {
      state.gameOver = true;
      state.phase = "gameOver";
      return;
    }

    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.playerCount;
    if (state.currentPlayerIndex === 0) state.turnNumber = (state.turnNumber || 1) + 1;
    state.phase = "awaitAction";
    state.mainActionDone = false;
    state.didEvolveThisTurn = false;
    state.selectedCard = null;
  }

  function applyActionToState(state, playerIndex, action) {
    const player = state?.players?.[playerIndex];
    if (!state || !player || state.gameOver || state.phase !== "awaitAction" || !action) return false;

    let ok = false;
    if (action.type === "buy") {
      const ref = findBuyTargetInState(state, player, action);
      if (!ref) return false;
      const payCost = calculatePayCostInState(state, player, ref.card);
      if (!payCost) return false;
      ALL_COLORS.forEach((color) => {
        player.tokens[color] -= payCost[color] || 0;
        state.supply[color] += payCost[color] || 0;
      });
      if (ref.source === "market") {
        state.market[ref.marketKey].splice(ref.index, 1);
        refillMarketInState(state, ref.marketKey);
      } else {
        player.reserved.splice(ref.index, 1);
      }
      player.tableau.push(ref.card);
      ok = true;
    } else if (action.type === "takeDifferent") {
      const colors = action.colors || [];
      if (!Array.isArray(colors) || colors.length !== 3) return false;
      if (colors.some((color) => !NORMAL_COLORS.includes(color))) return false;

      const countMap = {};
      colors.forEach((color) => { countMap[color] = (countMap[color] || 0) + 1; });
      const usedColors = Object.keys(countMap);

      const availableColors = NORMAL_COLORS.filter((color) => (state.supply[color] || 0) > 0);
      for (const color of usedColors) {
        if ((state.supply[color] || 0) < countMap[color]) return false;
      }

      if (availableColors.length >= 3) {
        if (usedColors.length !== 3) return false;
        if (usedColors.some((color) => countMap[color] !== 1)) return false;
      } else if (availableColors.length === 2) {
        if (usedColors.length !== 2) return false;
        if (!usedColors.every((color) => availableColors.includes(color))) return false;
        const counts = Object.values(countMap);
        if (counts.length !== 2 || !counts.includes(2) || !counts.includes(1)) return false;
      } else {
        return false;
      }

      colors.forEach((color) => {
        state.supply[color] -= 1;
        player.tokens[color] += 1;
      });
      ok = true;
    } else if (action.type === "takeSame") {
      if (!NORMAL_COLORS.includes(action.color) || (state.supply[action.color] || 0) < 4) return false;
      state.supply[action.color] -= 2;
      player.tokens[action.color] += 2;
      ok = true;
    } else if (action.type === "reserveMarket") {
      if ((player.reserved || []).length >= 3 || !["level1", "level2", "level3"].includes(action.marketKey)) return false;
      const ref = findMarketCardInState(state, action.marketKey, action.cardId);
      if (!ref) return false;
      state.market[action.marketKey].splice(ref.index, 1);
      player.reserved.push(ref.card);
      if ((state.supply.purple || 0) > 0) {
        state.supply.purple -= 1;
        player.tokens.purple += 1;
      }
      refillMarketInState(state, action.marketKey);
      ok = true;
    } else if (action.type === "reserveDeckTop") {
      if ((player.reserved || []).length >= 3 || !["level1", "level2", "level3"].includes(action.deckKey)) return false;
      if (!(state.decks[action.deckKey] || []).length) return false;
      player.reserved.push(state.decks[action.deckKey].pop());
      if ((state.supply.purple || 0) > 0) {
        state.supply.purple -= 1;
        player.tokens.purple += 1;
      }
      ok = true;
    }

    if (!ok) return false;
    state.mainActionDone = true;
    discardDownToLimitInState(state, player);
    state.phase = "evolve";
    applyBestEvolutionInState(state, playerIndex);
    updatePlayerScoreInState(player);
    advanceTurnInState(state);
    return true;
  }

  // =============================
  // v0.9.0 联机纯逻辑：applyOnlineActionToState
  // 不操作 DOM / 不调用 render / 不访问浏览器
  // =============================
  function findMatchingLegalAction(legalActions, action) {
    return legalActions.find((legal) => {
      if (legal.type !== action.type) return false;
      if (action.type === "takeDifferent") {
        const legalSorted = [...(legal.colors || [])].sort().join(",");
        const actionSorted = [...(action.colors || [])].sort().join(",");
        return legalSorted === actionSorted;
      }
      if (action.type === "takeSame") return legal.color === action.color;
      if (action.type === "buy") {
        return legal.source === action.source &&
          legal.cardId === action.cardId &&
          (legal.marketKey || "") === (action.marketKey || "");
      }
      if (action.type === "reserveMarket") return legal.marketKey === action.marketKey && legal.cardId === action.cardId;
      if (action.type === "reserveDeckTop") return legal.deckKey === action.deckKey;
      return false;
    }) || null;
  }

  function applyMainActionToState(state, playerIndex, action) {
    const player = state?.players?.[playerIndex];
    if (!state || !player || state.gameOver || state.phase !== "awaitAction" || !action) return false;

    let ok = false;
    let message = "";

    if (action.type === "buy") {
      const ref = findBuyTargetInState(state, player, action);
      if (!ref) return false;
      const payCost = calculatePayCostInState(state, player, ref.card);
      if (!payCost) return false;
      ALL_COLORS.forEach((color) => {
        player.tokens[color] -= payCost[color] || 0;
        state.supply[color] += payCost[color] || 0;
      });
      if (ref.source === "market") {
        state.market[ref.marketKey].splice(ref.index, 1);
        refillMarketInState(state, ref.marketKey);
      } else {
        player.reserved.splice(ref.index, 1);
      }
      player.tableau.push(ref.card);
      message = `${player.name} 捕捉了 ${getCardName(ref.card)}。`;
      ok = true;
    } else if (action.type === "takeDifferent") {
      const colors = action.colors || [];
      if (!Array.isArray(colors) || colors.length !== 3) return false;
      if (colors.some((color) => !NORMAL_COLORS.includes(color))) return false;
      const countMap = {};
      colors.forEach((color) => { countMap[color] = (countMap[color] || 0) + 1; });
      const usedColors = Object.keys(countMap);
      const availableColors = NORMAL_COLORS.filter((color) => (state.supply[color] || 0) > 0);
      for (const color of usedColors) {
        if ((state.supply[color] || 0) < countMap[color]) return false;
      }
      if (availableColors.length >= 3) {
        if (usedColors.length !== 3) return false;
        if (usedColors.some((color) => countMap[color] !== 1)) return false;
      } else if (availableColors.length === 2) {
        if (usedColors.length !== 2) return false;
        if (!usedColors.every((color) => availableColors.includes(color))) return false;
        const counts = Object.values(countMap);
        if (counts.length !== 2 || !counts.includes(2) || !counts.includes(1)) return false;
      } else {
        return false;
      }
      colors.forEach((color) => {
        state.supply[color] -= 1;
        player.tokens[color] += 1;
      });
      const msgParts = usedColors.map((color) => `${TOKEN_LABELS[color]} ×${countMap[color]}`).join("、");
      message = `${player.name} 拿取了 ${msgParts}。`;
      ok = true;
    } else if (action.type === "takeSame") {
      if (!NORMAL_COLORS.includes(action.color) || (state.supply[action.color] || 0) < 4) return false;
      state.supply[action.color] -= 2;
      player.tokens[action.color] += 2;
      message = `${player.name} 拿取了 2 个${TOKEN_LABELS[action.color]}。`;
      ok = true;
    } else if (action.type === "reserveMarket") {
      if ((player.reserved || []).length >= 3 || !["level1", "level2", "level3"].includes(action.marketKey)) return false;
      const ref = findMarketCardInState(state, action.marketKey, action.cardId);
      if (!ref) return false;
      state.market[action.marketKey].splice(ref.index, 1);
      player.reserved.push(ref.card);
      if ((state.supply.purple || 0) > 0) {
        state.supply.purple -= 1;
        player.tokens.purple += 1;
      }
      refillMarketInState(state, action.marketKey);
      message = `${player.name} 保留了 ${getCardName(ref.card)}。`;
      ok = true;
    } else if (action.type === "reserveDeckTop") {
      if ((player.reserved || []).length >= 3 || !["level1", "level2", "level3"].includes(action.deckKey)) return false;
      if (!(state.decks[action.deckKey] || []).length) return false;
      player.reserved.push(state.decks[action.deckKey].pop());
      if ((state.supply.purple || 0) > 0) {
        state.supply.purple -= 1;
        player.tokens.purple += 1;
      }
      message = `${player.name} 从牌堆顶保留了 1 张${MARKET_LABELS[action.deckKey]}卡。`;
      ok = true;
    }

    if (!ok) return false;
    if (message) {
      state.actionLog = (state.actionLog || []).concat([message]).slice(-120);
      state.lastMessage = message;
    }
    return true;
  }

  function applyManualEvolveToState(state, playerIndex, baseCardId, targetCardId) {
    const player = state.players?.[playerIndex];
    if (!player || state.didEvolveThisTurn) return { ok: false, error: "每回合最多进化 1 次" };
    const baseIndex = player.tableau.findIndex((card) => card.id === baseCardId);
    if (baseIndex < 0) return { ok: false, error: "基础卡不存在" };
    const baseCard = player.tableau[baseIndex];
    let targetRef = null;
    MARKET_KEYS.forEach((marketKey) => {
      (state.market[marketKey] || []).forEach((card, index) => {
        if (card.id === targetCardId && card.name_zh === baseCard.evolvesTo) {
          targetRef = { source: "market", marketKey, index, card };
        }
      });
    });
    (player.reserved || []).forEach((card, index) => {
      if (card.id === targetCardId && card.name_zh === baseCard.evolvesTo) {
        targetRef = { source: "reserved", index, card };
      }
    });
    if (!targetRef) return { ok: false, error: "进化目标卡不存在" };
    if (!canEvolveInState(state, player, baseCard, targetRef.card)) return { ok: false, error: "不满足进化条件" };

    player.tableau.splice(baseIndex, 1);
    player.evolvedArchive.push(baseCard);
    if (targetRef.source === "market") {
      state.market[targetRef.marketKey].splice(targetRef.index, 1);
      refillMarketInState(state, targetRef.marketKey);
    } else {
      player.reserved.splice(targetRef.index, 1);
    }
    player.tableau.push(targetRef.card);
    state.didEvolveThisTurn = true;
    updatePlayerScoreInState(player);
    const msg = `${player.name} 将 ${getCardName(baseCard)} 进化为 ${getCardName(targetRef.card)}。`;
    state.actionLog = (state.actionLog || []).concat([msg]).slice(-120);
    return { ok: true };
  }

  function finishOnlineTurn(state, playerIndex) {
    const player = state.players[playerIndex];
    if (!player) return;
    updatePlayerScoreInState(player);
    state.playerTurns[playerIndex] = (state.playerTurns[playerIndex] || 0) + 1;
    if (!state.finalRoundTriggered && (player.score || 0) >= 18) {
      state.finalRoundTriggered = true;
      state.finalTriggerPlayerIndex = playerIndex;
      state.finalTargetTurnCount = state.playerTurns[playerIndex];
      const msg = `${player.name} 达到 18 分，触发最终轮。`;
      state.actionLog = (state.actionLog || []).concat([msg]).slice(-120);
    }
    if (state.finalRoundTriggered && state.playerTurns.every((t) => t >= state.finalTargetTurnCount)) {
      state.gameOver = true;
      state.phase = "gameOver";
      return;
    }
    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.playerCount;
    if (state.currentPlayerIndex === 0) state.turnNumber = (state.turnNumber || 1) + 1;
    state.phase = "awaitAction";
    state.mainActionDone = false;
    state.didEvolveThisTurn = false;
    state.selectedCard = null;
  }

  function applyOnlineActionToState(state, playerIndex, action) {
    if (!state || state.gameOver) return { ok: false, error: "游戏已结束" };
    if (state.currentPlayerIndex !== playerIndex) return { ok: false, error: "还没轮到你" };
    const player = state.players?.[playerIndex];
    if (!player) return { ok: false, error: "玩家不存在" };

    const cloned = clone(state);
    const clonedPlayer = cloned.players[playerIndex];

    if (cloned.phase === "awaitAction") {
      if (cloned.mainActionDone) return { ok: false, error: "本回合主要行动已完成" };
      const legalActions = generateLegalActions(playerIndex, cloned);
      const matched = findMatchingLegalAction(legalActions, action);
      if (!matched) return { ok: false, error: "非法行动" };
      const applied = applyMainActionToState(cloned, playerIndex, matched);
      if (!applied) return { ok: false, error: "行动执行失败" };
      cloned.mainActionDone = true;
      cloned.selectedCard = null;
      cloned.phase = totalTokens(clonedPlayer.tokens) > 10 ? "discard" : "evolve";
      return { ok: true, state: cloned };
    }

    if (cloned.phase === "discard") {
      if (action.type !== "discard") return { ok: false, error: "当前需要丢弃 token" };
      if (!ALL_COLORS.includes(action.color) || (clonedPlayer.tokens[action.color] || 0) <= 0) {
        return { ok: false, error: "不能丢弃这个 token" };
      }
      clonedPlayer.tokens[action.color] -= 1;
      cloned.supply[action.color] += 1;
      const msg = `${clonedPlayer.name} 丢弃了 1 个${TOKEN_LABELS[action.color]}。`;
      cloned.actionLog = (cloned.actionLog || []).concat([msg]).slice(-120);
      if (totalTokens(clonedPlayer.tokens) <= 10) {
        cloned.phase = "evolve";
      }
      return { ok: true, state: cloned };
    }

    if (cloned.phase === "evolve") {
      if (action.type === "skipEvolution") {
        finishOnlineTurn(cloned, playerIndex);
        return { ok: true, state: cloned };
      }
      if (action.type === "evolve") {
        const result = applyManualEvolveToState(cloned, playerIndex, action.baseCardId, action.targetCardId);
        if (!result.ok) return { ok: false, error: result.error };
        finishOnlineTurn(cloned, playerIndex);
        return { ok: true, state: cloned };
      }
      return { ok: false, error: "当前阶段需要进化或跳过" };
    }

    return { ok: false, error: "当前阶段不可操作" };
  }

  function rankPlayersInState(state) {
    return (state.players || [])
      .map((player, index) => ({ player, index }))
      .sort((a, b) => {
        if ((b.player.score || 0) !== (a.player.score || 0)) return (b.player.score || 0) - (a.player.score || 0);
        if ((b.player.evolvedArchive?.length || 0) !== (a.player.evolvedArchive?.length || 0)) {
          return (b.player.evolvedArchive?.length || 0) - (a.player.evolvedArchive?.length || 0);
        }
        return (b.player.tableau?.length || 0) - (a.player.tableau?.length || 0);
      });
  }

  function evaluateState(state, playerIndex) {
    const player = state.players[playerIndex];
    if (!player) return -Infinity;
    updatePlayerScoreInState(player);
    state.players.forEach(updatePlayerScoreInState);

    const score = player.score || 0;
    const discount = calculateDiscountInState(state, player);
    const usefulDiscountValue = NORMAL_COLORS.reduce((sum, color) => (
      sum + (discount[color] || 0) * getUsefulDiscountValueInState(state, player, color, 1)
    ), 0);
    const evolutionOptions = getEvolveOptionsInState(state, playerIndex);
    const evolutionPotential = evolutionOptions.reduce((sum, option) => (
      sum + Math.max(0, scoreEvolutionOptionForAIInState(state, player, option))
    ), 0);
    const reservedPotential = (player.reserved || []).reduce((sum, card) => (
      sum + Math.max(0, evaluateCardForAIInState(state, player, card)) * 0.1
    ), 0);
    const target = chooseAITargetCardInState(state, player);
    const targetProgressScore = target?.card
      ? Math.max(0, target.shortage.requiredTotal - target.shortage.totalAfterPurple) * 4
      : 0;
    const wastedTokensPenalty = NORMAL_COLORS.reduce((sum, color) => {
      const targetNeeds = target?.shortage?.missing?.[color] || 0;
      const futureDemand = getUsefulColorDemandInState(state, player, color);
      const excess = Math.max(0, (player.tokens[color] || 0) - targetNeeds - Math.ceil(futureDemand / 3));
      return sum + excess;
    }, Math.max(0, totalTokens(player.tokens || {}) - 10) * 3);

    let value = score * 20
      + usefulDiscountValue * 8
      + evolutionPotential * 12
      + reservedPotential * 4
      + targetProgressScore
      - wastedTokensPenalty;

    // 空场惩罚：多回合没有买卡
    const stage = getGameStage(player);
    const tableauCount = (player.tableau || []).length;
    const reservedCount = (player.reserved || []).length;
    const playerTurns = state.playerTurns?.[playerIndex] || 0;

    // early 阶段更严厉的空场惩罚
    if (stage === "early") {
      value += tableauCount * 25;
      if (tableauCount === 0 && playerTurns >= 3) value -= 120;
      if (reservedCount >= 2 && tableauCount === 0) value -= 100;
      if (reservedCount >= 3) value -= 60;
    } else {
      if (tableauCount === 0 && playerTurns >= 3) value -= 80;
      if (reservedCount >= 2 && tableauCount === 0) value -= 60;
      if (reservedCount >= 3) value -= 40;
    }

    // special 卡价值
    const specialCaptured = (player.tableau || []).filter((c) => c.category === "rare" || c.category === "legend").length;
    value += specialCaptured * 35;
    const legendCaptured = (player.tableau || []).filter((c) => c.category === "legend").length;
    value += legendCaptured * 25;

    // 可买的 rare/legend 潜在价值（按阶段限幅）
    const affordableSpecials = getVisibleCardRefsInState(state, player).filter((ref) => {
      return (ref.card.category === "rare" || ref.card.category === "legend") && canBuyInState(state, player, ref.card);
    });
    if (stage === "early") value += affordableSpecials.length * 10;
    else if (stage === "mid") value += affordableSpecials.length * 25;
    else value += affordableSpecials.length * 45;

    // purple 在有 special 目标时加分（early 阶段限幅）
    if ((player.tokens?.purple || 0) > 0) {
      const hasSpecialTarget = getVisibleCardRefsInState(state, player).some((ref) =>
        (ref.card.category === "rare" || ref.card.category === "legend") && (ref.card.cost?.purple || 0) > 0
      );
      if (hasSpecialTarget) {
        const purpleBonus = stage === "early" ? 8 : 10;
        value += Math.min(player.tokens.purple, 2) * purpleBonus;
      }
    }

    if (score >= 18) value += 500;
    else if (score >= 15) value += 120;
    else if (score >= 12) value += 40;

    const others = state.players.filter((_, index) => index !== playerIndex);
    const bestOtherScore = others.length ? Math.max(...others.map((p) => p.score || 0), 0) : 0;
    value += (score - bestOtherScore) * 5;

    if (state.gameOver) {
      const ranking = rankPlayersInState(state);
      if (ranking[0]?.index === playerIndex) value += 1000;
    }
    return value;
  }

  function scoreActionForHeuristic(state, playerIndex, action) {
    const player = state.players[playerIndex];
    if (!player || !action) return -Infinity;
    const stage = getGameStage(player);
    if (action.type === "buy") {
      const ref = findBuyTargetInState(state, player, action);
      if (!ref?.card) return -Infinity;
      const payCost = calculatePayCostInState(state, player, ref.card) || emptyTokens();
      const payTotal = totalTokens(payCost);
      let value = 100 + evaluateCardForAIInState(state, player, ref.card) - payTotal * 1.5;
      if ((player.score || 0) + (Number(ref.card.points) || 0) >= 18) value += 100;
      // early 阶段买 level1 加分
      if (stage === "early" && (ref.card.level || 1) === 1) value += 70;
      // tableau 为空时第一张卡大幅加分
      if ((player.tableau || []).length === 0) value += 80;
      // 已有 reserved>=2 时能买卡额外加分
      if ((player.reserved || []).length >= 2) value += 40;
      // 有减免加分
      if (ref.card.bonus?.color) value += 20;
      // 有分数加分
      if ((ref.card.points || 0) > 0) value += ref.card.points * 10;
      // rare / legend 额外加分
      if (ref.card.category === "rare") {
        if (stage === "mid") value += 35;
        if (stage === "late") value += 70;
        value += (ref.card.points || 0) * 15;
        if (ref.card.bonus && (Number(ref.card.bonus.count) || 0) >= 2) value += 20;
      }
      if (ref.card.category === "legend") {
        if (stage === "mid") value += 45;
        if (stage === "late") value += 95;
        value += (ref.card.points || 0) * 18;
        if (ref.card.bonus && (Number(ref.card.bonus.count) || 0) >= 2) value += 28;
      }
      // 达到终局分数大幅加分
      if ((player.score || 0) + (Number(ref.card.points) || 0) >= 18) value += 160;
      const simPlayer = clone(player);
      simPlayer.tableau.push(ref.card);
      if (getEvolveOptionsInState({ ...state, players: state.players.map((p, index) => index === playerIndex ? simPlayer : p) }, playerIndex).length) {
        value += 20;
      }
      return value;
    }
    if (action.type === "takeDifferent" || action.type === "takeSame") {
      let tokenScore = 40 + scoreTokenActionForAIInState(state, player, action);
      // early 阶段有买得起的 level1 时，拿球扣分
      if (stage === "early") {
        const hasAffordableLevel1 = getVisibleCardRefsInState(state, player).some((ref) =>
          ref.card.level === 1 && ref.card.category === "normal" && canBuyInState(state, player, ref.card)
        );
        if (hasAffordableLevel1) tokenScore -= 60;
      }
      return tokenScore;
    }
    if (action.type === "reserveMarket") {
      const ref = findMarketCardInState(state, action.marketKey, action.cardId);
      return scoreReserveCardForAIInState(state, playerIndex, ref ? { ...ref, marketKey: action.marketKey } : null);
    }
    if (action.type === "reserveDeckTop") {
      let deckScore = 12;
      // early 阶段 reserveDeckTop 强扣分
      if (stage === "early") deckScore -= 70;
      // early 阶段 tableau 空 且 reserved>=1 时大幅扣分
      if (stage === "early" && (player.tableau || []).length === 0 && (player.reserved || []).length >= 1) deckScore -= 80;
      // reserved>=2 极大扣分
      if ((player.reserved || []).length >= 2) deckScore -= 90;
      return deckScore;
    }
    return 0;
  }

  function chooseHeuristicOrRandomAction(state, playerIndex, actions) {
    if (!actions.length) return null;
    if (Math.random() < 0.3) return actions[Math.floor(Math.random() * actions.length)];
    return actions
      .slice()
      .sort((a, b) => scoreActionForHeuristic(state, playerIndex, b) - scoreActionForHeuristic(state, playerIndex, a))[0];
  }

  function runRandomPlayout(state, rootPlayerIndex, maxTurns) {
    let turns = 0;
    while (!state.gameOver && turns < maxTurns) {
      const current = state.currentPlayerIndex;
      const actions = generateLegalActions(current, state);
      if (!actions.length) {
        state.gameOver = true;
        state.stalemate = true;
        state.phase = "gameOver";
        break;
      }
      const action = chooseHeuristicOrRandomAction(state, current, actions);
      if (!applyActionToState(state, current, action)) {
        state.gameOver = true;
        state.stalemate = true;
        state.phase = "gameOver";
        break;
      }
      turns += 1;
    }
    return evaluateState(state, rootPlayerIndex);
  }

  function getMCTSRuntimeConfig() {
    const aiCount = getAIPlayerCount();
    const playerCount = gameState?.playerCount || 2;

    if (window.__pokemonSplendorIsTesting) {
      return { simulationsPerAction: 2, maxPlayoutTurns: 5, maxCandidateActions: 8 };
    }

    if (aiCount >= 4 || playerCount >= 4) {
      return { simulationsPerAction: 3, maxPlayoutTurns: 8, maxCandidateActions: 12 };
    }

    if (aiCount === 3 || playerCount === 3) {
      return { simulationsPerAction: 5, maxPlayoutTurns: 12, maxCandidateActions: 14 };
    }

    return { simulationsPerAction: 8, maxPlayoutTurns: 16, maxCandidateActions: 16 };
  }

  function chooseActionByMCTS(playerIndex) {
    const legalActions = generateLegalActions(playerIndex, gameState);
    if (!legalActions.length) return null;

    const config = getMCTSRuntimeConfig();
    const sims = config.simulationsPerAction;
    const maxTurns = config.maxPlayoutTurns;

    // 候选裁剪：确保 buy 动作优先保留，reserve 动作不挤占
    const buyActions = legalActions.filter((a) => a.type === "buy");
    const tokenActions = legalActions.filter((a) => a.type === "takeDifferent" || a.type === "takeSame");
    const reserveActions = legalActions.filter((a) => a.type === "reserveMarket" || a.type === "reserveDeckTop");

    // 区分 special buy (rare/legend) 和 normal buy
    const getActionCard = (action) => {
      if (action.source === "reserved") {
        const card = gameState.players[playerIndex]?.reserved?.find((c) => c.id === action.cardId);
        return card || null;
      }
      const ref = findMarketCardInState(gameState, action.marketKey, action.cardId);
      return ref?.card || null;
    };
    const specialBuyActions = buyActions.filter((a) => {
      const card = getActionCard(a);
      return card && (card.category === "rare" || card.category === "legend");
    });
    const normalBuyActions = buyActions.filter((a) => {
      const card = getActionCard(a);
      return !card || (card.category !== "rare" && card.category !== "legend");
    });

    // 按 heuristic 排序各类动作
    specialBuyActions.sort((a, b) => scoreActionForHeuristic(gameState, playerIndex, b) - scoreActionForHeuristic(gameState, playerIndex, a));
    normalBuyActions.sort((a, b) => scoreActionForHeuristic(gameState, playerIndex, b) - scoreActionForHeuristic(gameState, playerIndex, a));
    tokenActions.sort((a, b) => scoreActionForHeuristic(gameState, playerIndex, b) - scoreActionForHeuristic(gameState, playerIndex, a));
    reserveActions.sort((a, b) => scoreActionForHeuristic(gameState, playerIndex, b) - scoreActionForHeuristic(gameState, playerIndex, a));

    // 候选合并：special buy 优先，然后 normal buy，再 token，最后 reserve
    const player = gameState.players[playerIndex];
    const stage = getGameStage(player);
    const maxSpecial = Math.min(specialBuyActions.length, 4);
    const maxNormal = Math.min(normalBuyActions.length, 4);
    const maxToken = Math.min(tokenActions.length, 4);
    // early 阶段 reserve 最多 1 个，其他阶段最多 2 个
    const maxReserve = stage === "early" ? Math.min(reserveActions.length, 1) : Math.min(reserveActions.length, 2);

    // 进一步拆分 reserve：reserveMarket vs reserveDeckTop
    const reserveMarketActions = reserveActions.filter((a) => a.type === "reserveMarket");
    const reserveDeckActions = reserveActions.filter((a) => a.type === "reserveDeckTop");

    let actions = [
      ...specialBuyActions.slice(0, maxSpecial),
      ...normalBuyActions.slice(0, maxNormal),
      ...tokenActions.slice(0, maxToken),
      ...reserveMarketActions.slice(0, stage === "early" ? 1 : 2),
      ...reserveDeckActions.slice(0, stage === "early" ? 0 : 1)
    ].slice(0, Math.max(1, config.maxCandidateActions));

    // 如果没有 buy 动作，用原始排序兜底
    if (!actions.length) {
      actions = legalActions
        .slice()
        .sort((a, b) => scoreActionForHeuristic(gameState, playerIndex, b) - scoreActionForHeuristic(gameState, playerIndex, a))
        .slice(0, Math.max(1, config.maxCandidateActions));
    }
    let bestAction = actions[0];
    let bestValue = -Infinity;

    actions.forEach((action) => {
      let total = 0;
      let completed = 0;
      for (let i = 0; i < sims; i++) {
        const simState = clone(gameState);
        if (!applyActionToState(simState, playerIndex, clone(action))) continue;
        total += runRandomPlayout(simState, playerIndex, maxTurns);
        completed += 1;
      }
      const average = completed ? total / completed : -Infinity;
      if (average > bestValue) {
        bestValue = average;
        bestAction = action;
      }
    });

    return {
      action: bestAction,
      value: bestValue,
      simulations: sims,
      maxPlayoutTurns: maxTurns,
      candidateCount: actions.length,
      legalActionCount: legalActions.length
    };
  }

  function describeAction(action) {
    if (!action) return "none";
    if (action.type === "buy") {
      const card = action.source === "reserved"
        ? gameState?.players?.[gameState.currentPlayerIndex]?.reserved?.find((c) => c.id === action.cardId)
        : findMarketCardInState(gameState, action.marketKey, action.cardId)?.card;
      const name = card ? getCardName(card) : action.cardId;
      const typeTag = card?.category === "rare" ? "（稀有）" : card?.category === "legend" ? "（传说）" : "";
      return `捕捉 ${name}${typeTag}`;
    }
    if (action.type === "takeDifferent") return `拿取 ${action.colors.map((c) => TOKEN_LABELS[c]).join(" ×1、")} ×1`;
    if (action.type === "takeSame") return `拿取 ${TOKEN_LABELS[action.color]} ×2`;
    if (action.type === "reserveMarket") {
      const card = findMarketCardInState(gameState, action.marketKey, action.cardId)?.card;
      const name = card ? getCardName(card) : action.cardId;
      return `保留 ${name}`;
    }
    if (action.type === "reserveDeckTop") {
      const levelMap = { level1: "1级", level2: "2级", level3: "3级" };
      return `保留牌堆顶（${levelMap[action.deckKey] || action.deckKey}）`;
    }
    return action.type;
  }

  function performAction(action, options = {}) {
    if (!gameState || !action) return { ok: false, message: "" };
    if (options.recordHistory !== false) pushHistorySnapshot();
    const player = currentPlayer();
    const playerIndex = gameState.currentPlayerIndex;

    if (action.type === "buy") {
      const ref = action.source === "reserved"
        ? { card: player.reserved.find((card) => card.id === action.cardId) }
        : findMarketCardInState(gameState, action.marketKey, action.cardId);
      const ok = performBuyCard(playerIndex, action.source, action.cardId, options);
      return { ok, message: ok ? `${player.name} buys ${getCardName(ref?.card || { id: action.cardId })}.` : "" };
    }

    if (action.type === "takeDifferent") {
      const ok = performTakeDifferentTokens(playerIndex, action.colors, options);
      return { ok, message: ok ? `${player.name} takes ${action.colors.map((color) => TOKEN_LABELS[color]).join("/")}.` : "" };
    }

    if (action.type === "takeSame") {
      const ok = performTakeTwoSameTokens(playerIndex, action.color, options);
      return { ok, message: ok ? `${player.name} takes 2 ${TOKEN_LABELS[action.color]}.` : "" };
    }

    if (action.type === "reserveMarket") {
      const ref = findMarketCardInState(gameState, action.marketKey, action.cardId);
      const ok = performReserveMarketCard(playerIndex, action.marketKey, action.cardId, options);
      return { ok, message: ok ? `${player.name} reserves ${getCardName(ref?.card || { id: action.cardId })}.` : "" };
    }

    if (action.type === "reserveDeckTop") {
      const ok = performReserveDeckTop(playerIndex, action.deckKey, options);
      return { ok, message: ok ? `${player.name} reserves from ${action.deckKey}.` : "" };
    }

    return { ok: false, message: "" };
  }

  function finishGame() {
    if (!gameState) return;
    gameState.phase = "gameOver";
    gameState.gameOver = true;
    clearAISchedule();
    saveGame();
    render();
    setTimeout(() => {
      const final = document.getElementById("finalScreen");
      if (final) final.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function finishGameByStalemate() {
    if (!gameState) return;
    gameState.stalemate = true;
    gameState.phase = "gameOver";
    gameState.gameOver = true;
    clearAISchedule();
    saveGame();
    render();
    setTimeout(() => {
      const final = document.getElementById("finalScreen");
      if (final) final.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  // =============================
  // 人类玩家动作（委托 perform 函数）
  // =============================
  function takeThreeDifferentTokens(colors) {
    if (!requireActionPhase()) return;
    pushHistorySnapshot();
    performTakeDifferentTokens(gameState.currentPlayerIndex, colors);
  }

  function takeTwoSameTokens(color) {
    if (!requireActionPhase()) return;
    pushHistorySnapshot();
    performTakeTwoSameTokens(gameState.currentPlayerIndex, color);
  }

  function reserveSelectedCard() {
    if (!requireActionPhase()) return;
    pushHistorySnapshot();
    const ref = getSelectedCardRef();
    if (!ref || ref.source !== "market" || !["level1", "level2", "level3"].includes(ref.marketKey)) {
      notify("请先选择公共区中的 1/2/3 级卡。", "error");
      return;
    }
    performReserveMarketCard(gameState.currentPlayerIndex, ref.marketKey, ref.card.id);
  }

  function blindReserve(deckKey) {
    if (!requireActionPhase()) return;
    pushHistorySnapshot();
    performReserveDeckTop(gameState.currentPlayerIndex, deckKey);
  }

  function buySelectedCard() {
    if (!requireActionPhase()) return;
    const player = currentPlayer();
    const ref = getSelectedCardRef();
    if (!ref || !["market", "reserved"].includes(ref.source)) {
      notify("请先选择公共区或保留区的一张卡。", "error");
      return;
    }
    const payCost = calculatePayCost(player, ref.card);
    if (!payCost) {
      notify("token 不足，无法捕捉这张卡。", "error");
      return;
    }
    const ok = window.confirm(
      `确认捕捉 ${getCardName(ref.card)}？\n\n` +
      `原始费用：${tokenText(ref.card.cost)}\n` +
      `实际支付：${tokenText(payCost)}\n` +
      `捕捉后分数：${player.score + (Number(ref.card.points) || 0)}`
    );
    if (!ok) return;
    pushHistorySnapshot();
    performBuyCard(gameState.currentPlayerIndex, ref.source, ref.card.id);
  }

  function discardToken(color) {
    if (!gameState || gameState.phase !== "discard") return;
    if (onlineMode && !isOnlineLocalTurn()) { notify("还没轮到你。", "warn"); return; }
    pushHistorySnapshot();
    performDiscardToken(gameState.currentPlayerIndex, color);
  }

  function skipEvolution() {
    if (onlineMode) {
      if (!isOnlineLocalTurn()) { notify("还没轮到你。", "warn"); return; }
      submitOnlineAction({ type: "skipEvolution" });
      return;
    }
    if (!gameState || gameState.phase !== "evolve") {
      notify("需要先完成主要行动并处理 token 上限。", "error");
      return;
    }
    pushHistorySnapshot();
    performEndTurn({ skipHistory: true });
  }

  function evolveAndEndTurn(baseCardId, targetCardId) {
    if (performEvolve(gameState.currentPlayerIndex, baseCardId, targetCardId)) {
      performEndTurn({ skipHistory: true });
    }
  }

  function handleEvolveCardClick(targetCardId, source, marketKey) {
    if (!gameState || gameState.phase !== "evolve") return;
    const player = currentPlayer();
    if (!player || player.isAI) return;
    if (onlineMode && !isOnlineLocalTurn()) { notify("还没轮到你。", "warn"); return; }

    const options = getEvolveOptions(player);
    // 找到所有能进化到这张目标卡的 base
    const matching = options.filter((opt) => opt.targetCard.id === targetCardId);
    if (matching.length === 0) {
      notify("这张卡当前不满足进化条件。", "warn");
      return;
    }
    if (matching.length === 1) {
      // 只有一个 base，直接执行
      evolveAndEndTurn(matching[0].baseCard.id, targetCardId);
      return;
    }
    // 多个 base，用 confirm 选择
    const baseList = matching.map((opt) => getCardName(opt.baseCard)).join(" / ");
    const choice = window.prompt(
      `多个宝可梦可以进化到这张卡：\n${baseList}\n\n请输入序号（1-${matching.length}）：`
    );
    const idx = Number(choice) - 1;
    if (idx >= 0 && idx < matching.length) {
      evolveAndEndTurn(matching[idx].baseCard.id, targetCardId);
    }
  }

  function endTurn(options = {}) {
    performEndTurn(options);
  }

  function buyCard(player, cardId) {
    const ref = findBuyableCardRef(player, cardId);
    if (!ref) return false;
    return performBuyCard(resolvePlayerIndex(player), ref.source, cardId);
  }

  function evolvePokemon(playerIndex, baseCardId, targetCardId) {
    return performEvolve(resolvePlayerIndex(playerIndex), baseCardId, targetCardId);
  }

  // =============================
  // AI 动画工具
  // =============================
  function flashElement(element, className, duration = 900) {
    if (!element) return Promise.resolve();
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);

    return new Promise((resolve) => {
      setTimeout(() => {
        element.classList.remove(className);
        resolve();
      }, duration);
    });
  }

  function findCardElement(cardId) {
    try {
      return document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    } catch (e) {
      return document.querySelector(`[data-card-id="${cardId}"]`);
    }
  }

  function findTokenElements(color) {
    return [...document.querySelectorAll(`[data-token-color="${color}"], .token.${color}`)];
  }

  async function flashCard(cardId, className) {
    if (isTestingMode() || isFastSpectatorAI()) return;
    render();
    await wait(50);
    const el = findCardElement(cardId);
    await flashElement(el, className);
  }

  async function flashTokens(colors, className = "ai-flash-token") {
    if (isTestingMode() || isFastSpectatorAI()) return;
    render();
    await wait(50);
    const unique = [...new Set(colors)];
    unique.forEach((color) => {
      findTokenElements(color).forEach((el) => {
        el.classList.remove(className);
        void el.offsetWidth;
        el.classList.add(className);
      });
    });
    await wait(900);
    unique.forEach((color) => {
      findTokenElements(color).forEach((el) => el.classList.remove(className));
    });
  }

  async function flashCurrentPlayerPanel() {
    if (isFastSpectatorAI()) return;
    render();
    await wait(50);
    const panel = document.querySelector(".player-panel");
    await flashElement(panel, "ai-flash-player");
  }

  function addActionLog(message) {
    if (!gameState || !message) return;
    if (!Array.isArray(gameState.actionLog)) gameState.actionLog = [];
    gameState.actionLog.push({
      turn: gameState.turnNumber,
      player: currentPlayer()?.name || "",
      message,
      time: Date.now()
    });
    if (gameState.actionLog.length > 120) {
      gameState.actionLog.splice(0, gameState.actionLog.length - 120);
    }
  }

  // =============================
  // AI 玩家
  // =============================
  function toggleAIPause() {
    aiPaused = !aiPaused;
    if (aiPaused) clearAISchedule();
    notify(aiPaused ? "AI 已暂停。" : "AI 已继续。", "info");
    render();
    if (!aiPaused) maybeRunAITurn();
  }

  function getAITurnKey() {
    if (!gameState) return "";
    return [
      aiScheduleVersion,
      gameState.currentPlayerIndex,
      gameState.turnNumber,
      gameState.playerTurns?.[gameState.currentPlayerIndex] || 0
    ].join(":");
  }

  function isCurrentTurnKey(key) {
    return key && key === getAITurnKey();
  }

  function isActiveAIScheduleKey(key) {
    return key && String(key).split(":")[0] === String(aiScheduleVersion);
  }

  function clearAISchedule() {
    aiScheduleVersion += 1;
    if (aiTimerId !== null) {
      clearTimeout(aiTimerId);
      aiTimerId = null;
    }
    aiThinking = false;
    aiTurnKey = null;
  }

  function scheduleNextAIIfNeeded() {
    if (!gameState || gameState.gameOver) return;
    if (aiPaused) return;

    const player = currentPlayer();
    if (!player?.isAI) return;
    if (gameState.phase !== "awaitAction") return;

    const key = getAITurnKey();
    if (aiTimerId !== null && aiTurnKey === key) return;
    if (aiTimerId !== null && aiTurnKey !== key) {
      clearTimeout(aiTimerId);
      aiTimerId = null;
    }

    aiTurnKey = key;
    aiTimerId = window.setTimeout(() => {
      aiTimerId = null;
      if (aiTurnKey === key && !aiThinking) aiTurnKey = null;
      if (!isActiveAIScheduleKey(key)) return;
      if (!isCurrentTurnKey(key)) {
        scheduleNextAIIfNeeded();
        return;
      }
      maybeRunAITurn();
    }, 0);
  }

  function maybeRunAITurn() {
    if (!gameState || gameState.gameOver) return;
    if (aiPaused) return;
    if (onlineMode) return; // 联机模式 AI 由服务器处理

    const player = currentPlayer();
    if (!player?.isAI) return;
    if (gameState.phase !== "awaitAction") return;

    const key = getAITurnKey();

    if (aiThinking && aiTurnKey === key) return;
    if (aiTimerId !== null && aiTurnKey === key) return;
    if (aiTimerId !== null && aiTurnKey !== key) {
      clearTimeout(aiTimerId);
      aiTimerId = null;
      aiThinking = false;
      aiTurnKey = null;
    }

    aiThinking = true;
    aiTurnKey = key;

    notify(`${player.name} 正在思考...`, "info");

    const timerId = window.setTimeout(() => {
      if (aiTimerId === timerId) aiTimerId = null;

      if (!isActiveAIScheduleKey(key)) {
        if (aiTurnKey === key) {
          aiThinking = false;
          aiTurnKey = null;
        }
        return;
      }

      if (aiPaused) {
        if (aiTurnKey === key) {
          aiThinking = false;
          aiTurnKey = null;
        }
        return;
      }

      if (!isCurrentTurnKey(key)) {
        if (aiTurnKey === key) {
          aiThinking = false;
          aiTurnKey = null;
        }
        scheduleNextAIIfNeeded();
        return;
      }

      runAITurn(key);
    }, getAIStepDelay());
    aiTimerId = timerId;
  }

  function aiHasAnyLegalMainAction(player) {
    if (!gameState || !player) return false;

    for (const card of (player.reserved || [])) {
      if (canBuy(player, card)) return true;
    }

    for (const key of MARKET_KEYS) {
      for (const card of (gameState.market[key] || [])) {
        if (canBuy(player, card)) return true;
      }
    }

    if (getLegalTakeDifferentTokenActionsFromSupply(gameState.supply).length > 0) return true;

    if (NORMAL_COLORS.some((c) => gameState.supply[c] >= 4)) return true;

    if ((player.reserved || []).length < 3) {
      for (const key of ["level1", "level2", "level3"]) {
        if ((gameState.market[key] || []).length > 0) return true;
        if ((gameState.decks[key] || []).length > 0) return true;
      }
    }

    return false;
  }

  function aiFallbackLegalAction(player) {
    const takeDifferentActions = getLegalTakeDifferentTokenActionsFromSupply(gameState.supply);

    if (takeDifferentActions.length > 0) {
      const chosen = takeDifferentActions[0].colors;
      if (performTakeDifferentTokens(gameState.currentPlayerIndex, chosen, { actor: "ai" })) {
        const message = `${player.name} 拿取了 ${[...new Set(chosen)].map((color) => TOKEN_LABELS[color]).join("、")}。`;
        return { ok: true, message, colors: chosen };
      }
    }

    const sameResult = takeTwoSameTokensForAI(player);
    if (sameResult.ok) return sameResult;

    if ((player.reserved || []).length < 3) {
      for (const key of ["level1", "level2", "level3"]) {
        if ((gameState.market[key] || []).length > 0) {
          const card = gameState.market[key][0];
          if (performReserveMarketCard(gameState.currentPlayerIndex, key, card.id, { actor: "ai" })) {
            const message = `${player.name} 保留了 ${getCardName(card)}。`;
            return { ok: true, message, cardId: card.id };
          }
        }
      }
    }

    return { ok: false, message: "", cardId: null };
  }

  async function runAITurn(expectedKey, options = {}) {
    if (!gameState || gameState.gameOver) {
      if (aiTurnKey === expectedKey) {
        aiThinking = false;
        aiTurnKey = null;
      }
      return;
    }

    const player = currentPlayer();
    if (!player?.isAI) {
      if (aiTurnKey === expectedKey) {
        aiThinking = false;
        aiTurnKey = null;
      }
      return;
    }

    if (!isCurrentTurnKey(expectedKey)) {
      if (aiTurnKey === expectedKey) {
        aiThinking = false;
        aiTurnKey = null;
      }
      scheduleNextAIIfNeeded();
      return;
    }

    try {
      pushHistorySnapshot();

      if (!aiHasAnyLegalMainAction(player)) {
        const msg = `${player.name} 没有合法主行动，游戏进入停滞结算。`;
        addActionLog(msg);
        notify(msg, "warn");
        finishGameByStalemate();
        return;
      }

      const fastSpectatorAI = isFastSpectatorAI();
      notify(`${player.name} 正在思考...`, "info");
      if (!fastSpectatorAI) render();
      await wait(getAIStepDelay());

      if (!isCurrentTurnKey(expectedKey)) return;

      const decision = chooseActionByMCTS(gameState.currentPlayerIndex);
      if (!decision || !decision.action) {
        const msg = `${player.name} 的 MCTS 没有找到合法行动，游戏进入停滞结算。`;
        addActionLog(msg);
        notify(msg, "warn");
        finishGameByStalemate();
        return;
      }

      const target = chooseAITargetCard(player);
      const actionText = describeAction(decision.action);
      const result = performAction(decision.action, { actor: "ai", recordHistory: false, log: true });
      if (result?.ok) {
        const stage = getGameStage(player);
        const targetName = target?.card
          ? getCardName(target.card) + (target.card.category === "rare" ? "（稀有）" : target.card.category === "legend" ? "（传说）" : target.card.category === "normal" && target.card.level ? `（${target.card.level}级）` : "")
          : "局面最优行动";
        result.message = `${player.name} 使用 MCTS[${stage}]：候选动作 ${decision.candidateCount} 个，模拟 ${decision.simulations}×${decision.maxPlayoutTurns}。选择目标：${targetName}。执行行动：${actionText}。`;
      }

      if (!result?.ok) {
        const msg = `${player.name} 的 MCTS 行动执行失败，游戏进入停滞结算。`;
        addActionLog(msg);
        notify(msg, "warn");
        finishGameByStalemate();
        return;
      }

      if (result?.message) {
        addActionLog(result.message);
        notify(result.message, "info");
        if (!fastSpectatorAI) {
          render();
          await wait(getAIStepDelay());
        }
      }

      if (!isCurrentTurnKey(expectedKey)) return;

      await handleAIAfterMainActionSlow(player, expectedKey);

      if (options.singleStep) {
        aiPaused = true;
        render();
      }

    } finally {
      if (aiTurnKey === expectedKey) {
        aiThinking = false;
        aiTurnKey = null;
      }

      if (isActiveAIScheduleKey(expectedKey)) {
        scheduleNextAIIfNeeded();
      }
    }
  }

  async function aiTryBuyBestCard(player) {
    const candidates = [];

    player.reserved.forEach((card, index) => {
      if (canBuy(player, card)) {
        candidates.push({ card, source: "reserved", index });
      }
    });

    MARKET_KEYS.forEach((key) => {
      gameState.market[key].forEach((card, index) => {
        if (canBuy(player, card)) {
          candidates.push({ card, source: "market", marketKey: key, index });
        }
      });
    });

    if (!candidates.length) return null;

    candidates.forEach((candidate) => {
      const payCost = calculatePayCost(player, candidate.card) || emptyTokens();
      const payTotal = totalTokens(payCost);
      let value = evaluateCardForAI(player, candidate.card) - payTotal * 1.5;
      if ((player.score || 0) + (Number(candidate.card.points) || 0) >= 18) value += 100;

      const simState = clone(gameState);
      const simPlayer = simState.players[gameState.currentPlayerIndex];
      simPlayer.tableau.push(candidate.card);
      updatePlayerScoreInState(simPlayer);
      if (getEvolveOptionsInState(simState, gameState.currentPlayerIndex).length > getEvolveOptions(player).length) {
        value += 20;
      }

      candidate.aiValue = value;
      candidate.payCost = payCost;
    });

    candidates.sort((a, b) => b.aiValue - a.aiValue);
    const best = candidates[0];
    const payCost = best.payCost;

    // 先 flash 动画，再执行 perform（避免 DOM 元素消失）
    try { await flashCard(best.card.id, "ai-flash-buy"); } catch (e) { /* 动画失败不影响规则 */ }

    const success = performBuyCard(gameState.currentPlayerIndex, best.source, best.card.id, { actor: "ai" });
    if (!success) return null;

    // 再 flash token 动画
    if (payCost) {
      try { await flashTokens(Object.entries(payCost).filter(([, v]) => v > 0).map(([c]) => c), "ai-flash-token"); } catch (e) { /* 动画失败不影响规则 */ }
    }

    return {
      ok: true,
      message: `${player.name} 捕捉了 ${getCardName(best.card)}${best.card.bonus?.color ? `，获得 ${TOKEN_LABELS[best.card.bonus.color]} 减免` : ""}${best.card.evolvesTo ? "，推进进化路线" : ""}。`,
      cardId: best.card.id,
      payCost
    };
  }

  function getRequiredDifferentTokenCount() {
    return getLegalTakeDifferentTokenActionsFromSupply(gameState?.supply).length > 0 ? 3 : 0;
  }

  function takeDifferentTokensForAI(player, preferredColors = []) {
    const legalActions = getLegalTakeDifferentTokenActionsFromSupply(gameState?.supply);
    if (!legalActions.length) {
      return { ok: false, message: "", colors: [] };
    }

    const preferredSet = new Set((preferredColors || []).filter((color) => NORMAL_COLORS.includes(color)));
    const chosen = legalActions
      .slice()
      .sort((a, b) => {
        const score = (action) => action.colors.reduce((sum, color) => sum + (preferredSet.has(color) ? 1 : 0), 0);
        return score(b) - score(a);
      })[0].colors;

    const success = performTakeDifferentTokens(gameState.currentPlayerIndex, chosen, { actor: "ai" });
    if (!success) return { ok: false, message: "", colors: [] };

    const message = `${player.name} 拿取了 ${[...new Set(chosen)].map((color) => TOKEN_LABELS[color]).join("、")}。`;
    return { ok: true, message, colors: chosen };
  }

  function takeTwoSameTokensForAI(player, preferredColors = []) {
    const candidates = [];
    const addCandidate = (color) => {
      if (NORMAL_COLORS.includes(color) && gameState.supply[color] >= 4 && !candidates.includes(color)) {
        candidates.push(color);
      }
    };

    preferredColors.forEach(addCandidate);
    NORMAL_COLORS.forEach(addCandidate);

    const color = candidates[0];
    if (!color) return { ok: false, message: "", colors: [] };

    const success = performTakeTwoSameTokens(gameState.currentPlayerIndex, color, { actor: "ai" });
    if (!success) return { ok: false, message: "", colors: [] };

    const message = `${player.name} takes 2 ${TOKEN_LABELS[color]}.`;
    return { ok: true, message, colors: [color, color], color };
  }

  function aiTakeUsefulTokens(player) {
    const target = chooseAITargetCard(player);
    const actions = generateLegalActions(gameState.currentPlayerIndex, gameState)
      .filter((action) => action.type === "takeDifferent" || action.type === "takeSame");

    if (!actions.length) return { ok: false, message: "", colors: [] };

    const scoredActions = actions
      .map((action) => ({
        action,
        value: scoreTokenActionForAIInState(gameState, player, action, target)
      }))
      .sort((a, b) => b.value - a.value);

    const best = scoredActions[0]?.action;
    if (!best) return { ok: false, message: "", colors: [] };

    let success = false;
    let colors = [];
    if (best.type === "takeDifferent") {
      colors = best.colors;
      success = performTakeDifferentTokens(gameState.currentPlayerIndex, best.colors, { actor: "ai" });
    } else if (best.type === "takeSame") {
      colors = [best.color, best.color];
      success = performTakeTwoSameTokens(gameState.currentPlayerIndex, best.color, { actor: "ai" });
    }

    if (!success) return { ok: false, message: "", colors: [] };

    const targetName = target?.card ? getCardName(target.card) : "当前目标";
    return {
      ok: true,
      message: `${player.name} 选择目标：${targetName}。${player.name} 拿取 ${formatTokenListForAction(best)}，用于捕捉${targetName}。`,
      colors,
      targetCardId: target?.card?.id || null
    };
  }

  async function aiReserveUsefulCard(player) {
    if (player.reserved.length >= 3) return { ok: false, message: `${player.name} 已保留 3 张卡，无法继续保留。`, cardId: null };

    const candidates = [];
    ["level1", "level2", "level3"].forEach((key) => {
      gameState.market[key].forEach((card, index) => {
        candidates.push({
          card,
          key,
          marketKey: key,
          index,
          aiValue: scoreReserveCardForAIInState(gameState, gameState.currentPlayerIndex, { card, marketKey: key, index })
        });
      });
    });

    if (!candidates.length) return { ok: false, message: `${player.name} 没有可保留的卡。`, cardId: null };

    candidates.sort((a, b) => b.aiValue - a.aiValue);
    const best = candidates[0];
    if (!best || best.aiValue === -Infinity) return { ok: false, message: `${player.name} 没有值得保留的卡。`, cardId: null };

    // 先 flash 动画，再执行 perform（避免 DOM 元素消失）
    try { await flashCard(best.card.id, "ai-flash-reserve"); } catch (e) { /* 动画失败不影响规则 */ }

    const success = performReserveMarketCard(gameState.currentPlayerIndex, best.key, best.card.id, { actor: "ai" });
    if (!success) return { ok: false, message: `${player.name} 保留失败。`, cardId: null };

    return {
      ok: true,
      message: `${player.name} 保留了 ${getCardName(best.card)}${isEvolutionTargetForPlayer(player, best.card) ? "，用于进化路线" : "，作为后续目标"}。`,
      cardId: best.card.id
    };
  }

  function aiEvolve(player, option) {
    return performEvolve(gameState.currentPlayerIndex, option.baseCard.id, option.targetCard.id, { actor: "ai" });
  }

  async function handleAIAfterMainActionSlow(player, expectedKey) {
    if (!isCurrentTurnKey(expectedKey)) return;
    const fastSpectatorAI = isFastSpectatorAI();

    while (totalTokens(player.tokens) > 10 && gameState.phase === "discard") {
      if (!isCurrentTurnKey(expectedKey)) return;

      const normalColors = NORMAL_COLORS
        .slice()
        .sort((a, b) => (player.tokens[b] || 0) - (player.tokens[a] || 0))
        .find((c) => (player.tokens[c] || 0) > 0);
      const color = normalColors || (player.tokens.purple > 0 ? "purple" : null);
      if (!color) break;

      const success = performDiscardToken(gameState.currentPlayerIndex, color, { actor: "ai" });
      if (!success) break;

      const msg = `${player.name} 丢弃了 1 个 ${TOKEN_LABELS[color]}。`;
      addActionLog(msg);
      notify(msg, "info");
      if (!fastSpectatorAI) render();
      await wait(getAIStepDelay());
    }

    if (!isCurrentTurnKey(expectedKey)) return;

    if (gameState.phase === "evolve" && !gameState.didEvolveThisTurn) {
      const options = getEvolveOptions(player);
      if (options.length) {
        options.sort((a, b) => scoreEvolutionOptionForAIInState(gameState, player, b) - scoreEvolutionOptionForAIInState(gameState, player, a));

        const best = options[0];
        if (scoreEvolutionOptionForAIInState(gameState, player, best) <= 0) {
          endTurn({ skipHistory: true, fromAI: true });
          return;
        }

        await flashCard(best.baseCard.id, "ai-flash-evolve-base");
        await flashCard(best.targetCard.id, "ai-flash-evolve-target");
        if (!fastSpectatorAI) await wait(getAIStepDelay());

        if (!isCurrentTurnKey(expectedKey)) return;

        aiEvolve(player, best);

        const msg = `${player.name} 将 ${getCardName(best.baseCard)} 进化为 ${getCardName(best.targetCard)}。`;
        addActionLog(msg);
        notify(msg, "info");
        render();
        if (!fastSpectatorAI) await wait(getAIStepDelay());
      }
    }

    if (!isCurrentTurnKey(expectedKey)) return;

    const endMsg = `${player.name} 结束回合。`;
    addActionLog(endMsg);
    notify(endMsg, "info");
    await flashCurrentPlayerPanel();
    if (!fastSpectatorAI) await wait(getAIStepDelay());

    if (!isCurrentTurnKey(expectedKey)) return;

    endTurn({ skipHistory: true, fromAI: true });
  }

  function rankPlayers() {
    return gameState.players
      .map((player, index) => ({ player, index }))
      .sort((a, b) => {
        if (b.player.score !== a.player.score) return b.player.score - a.player.score;
        if (b.player.evolvedArchive.length !== a.player.evolvedArchive.length) {
          return b.player.evolvedArchive.length - a.player.evolvedArchive.length;
        }
        return b.player.tableau.length - a.player.tableau.length;
      });
  }

  // =============================
  // 查询选中卡与可购买目标
  // =============================
  function setSelectedCard(source, cardId, marketKey = "", ownerIndex) {
    gameState.selectedCard = { source, cardId, marketKey, ownerIndex };
    render();
  }

  function getSelectedCardRef() {
    if (!gameState?.selectedCard) return null;
    const { source, cardId, marketKey, ownerIndex } = gameState.selectedCard;
    if (source === "market" && gameState.market[marketKey]) {
      const index = gameState.market[marketKey].findIndex((card) => card.id === cardId);
      if (index >= 0) return { source, marketKey, index, card: gameState.market[marketKey][index] };
    }
    if (source === "reserved") {
      const player = currentPlayer();
      const index = player.reserved.findIndex((card) => card.id === cardId);
      if (index >= 0) return { source, marketKey: "", index, card: player.reserved[index] };
    }
    if (source === "opponentReserved") {
      const player = gameState.players[ownerIndex];
      if (player) {
        const index = player.reserved.findIndex((card) => card.id === cardId);
        if (index >= 0) return { source, marketKey: "", index, card: player.reserved[index], ownerIndex };
      }
    }
    return null;
  }

  function findBuyableCardRef(player, cardId) {
    const selected = getSelectedCardRef();
    if (selected?.card?.id === cardId && (selected.source === "market" || selected.source === "reserved")) {
      return selected;
    }
    const reservedIndex = player.reserved.findIndex((card) => card.id === cardId);
    if (reservedIndex >= 0) {
      return { source: "reserved", index: reservedIndex, card: player.reserved[reservedIndex], marketKey: "" };
    }
    for (const key of MARKET_KEYS) {
      const index = gameState.market[key].findIndex((card) => card.id === cardId);
      if (index >= 0) {
        return { source: "market", marketKey: key, index, card: gameState.market[key][index] };
      }
    }
    return null;
  }

  // =============================
  // 渲染函数
  // =============================
  function findCardEverywhere(cardId) {
    if (!gameState && !cardDatabase.length) return null;
    for (const key of MARKET_KEYS) {
      const card = gameState?.market[key]?.find((c) => c.id === cardId);
      if (card) return card;
    }
    const player = currentPlayer();
    if (player) {
      const reservedCard = player.reserved.find((c) => c.id === cardId);
      if (reservedCard) return reservedCard;
      const tableauCard = player.tableau.find((c) => c.id === cardId);
      if (tableauCard) return tableauCard;
      const evolvedCard = player.evolvedArchive?.find((c) => c.id === cardId);
      if (evolvedCard) return evolvedCard;
    }
    return cardDatabase.find((c) => c.id === cardId) || null;
  }

  function openCardPreview(cardId) {
    if (!els.cardPreviewModal) return;
    const card = findCardEverywhere(cardId);
    if (!card) {
      notify("没有找到这张卡。", "warn");
      return;
    }
    els.cardPreviewContent.innerHTML = `
      <img class="card-preview-image" src="${escapeHtml(card.image || "")}" alt="${escapeHtml(getCardName(card))}" onerror="this.style.display='none'">
      <div class="card-preview-info">
        <h2>${escapeHtml(getCardName(card))}</h2>
        <p>${escapeHtml(cardTypeText(card))}${card.name_en ? ` / ${escapeHtml(card.name_en)}` : ""}</p>
        <p>分数：${Number(card.points) || 0}</p>
        <p>减免：${renderBonusIcon(card)}</p>
        <p>费用：${renderTokenIcons(card.cost)}</p>
        <p>进化为：${escapeHtml(card.evolvesTo || "无")}</p>
        <p>进化条件：${renderTokenIcons(card.evolveCost)}</p>
      </div>
    `;
    els.cardPreviewModal.classList.remove("hidden");
  }

  function closeCardPreview() {
    if (els.cardPreviewModal) {
      els.cardPreviewModal.classList.add("hidden");
      els.cardPreviewContent.innerHTML = "";
    }
  }

  function openRulesModal() {
    if (!els.rulesModal) return;
    els.rulesModal.classList.remove("hidden");
  }

  function closeRulesModal() {
    if (!els.rulesModal) return;
    els.rulesModal.classList.add("hidden");
  }

  function render() {
    renderDataStatus();
    renderScreens();
    if (!gameState) return;
    renderPlayerPanel();
    renderPlayersSidebar();
    renderBoard();
    renderSupplyColumn();
    renderActions();
    renderActionLog();
    renderDebug();
    renderFinalScreen();
    renderSpectatorControls();
    maybeRunAITurn();
  }

  function renderSpectatorControls() {
    if (!gameState) return;
    const hasAI = gameState.players.some((p) => p.isAI);
    setVisible(els.toggleAIPauseButton, hasAI);
    if (els.toggleAIPauseButton) {
      els.toggleAIPauseButton.textContent = aiPaused ? "继续 AI" : "暂停 AI";
    }
    setVisible(els.aiStepButton, hasAI && aiPaused);
    setVisible(els.aiSpeedRow, hasAI);
    if (els.spectatorNotice) {
      setVisible(els.spectatorNotice, gameState.spectatorMode);
    }
  }

  function renderDataStatus() {
    const count = cardDatabase.length;
    if (!count) {
      els.cardDataStatus.textContent = "未读取卡牌数据，请选择 cards.json";
      return;
    }
    const source = cardDataSource.includes("缓存")
      ? "本地缓存"
      : cardDataSource;
    els.cardDataStatus.textContent = `已读取 ${count} 张卡牌：${source}`;
  }

  function renderScreens() {
    const hasCards = cardDatabase.length > 0;
    setVisible(els.loadScreen, !hasCards && !gameState);
    setVisible(els.startScreen, hasCards && !gameState);
    setVisible(els.gameScreen, Boolean(gameState));
    setVisible(els.debugPanel, Boolean(gameState));
  }

  function renderPlayerPanel() {
    const player = currentPlayer(); // 当前回合的玩家（顶栏展示）
    const localP = localPlayer(); // 本地视角的玩家（底部玩家区展示）
    const localSeat = onlineMode && onlineSeatIndex != null ? onlineSeatIndex : gameState.currentPlayerIndex;

    // 顶部状态栏：房间号 + 身份 + 我的回合? + 当前玩家 + 阶段 + 轮次 + 连接状态
    if (els.roomBadge) {
      if (gameState.onlineMode) {
        els.roomBadge.textContent = `联机｜房间 ${gameState.roomId || "—"}`;
        els.roomBadge.classList.add("online");
      } else {
        els.roomBadge.textContent = "单机模式";
        els.roomBadge.classList.remove("online");
      }
    }
    if (els.topCurrentPlayer) {
      const turnOwnerName = player ? `${player.isAI ? "[AI] " : ""}${player.name} 的回合` : "等待开始";
      if (gameState.onlineMode) {
        const myTurn = onlineMode && onlineSeatIndex != null && gameState.currentPlayerIndex === onlineSeatIndex;
        const identity = onlineIdentityText();
        const turnHint = onlineSeatIndex != null ? (myTurn ? "你的回合" : `当前：${player?.name || "—"} 的回合`) : "等待开始";
        const conn = onlineConnectText();
        els.topCurrentPlayer.textContent = `${identity}｜${turnHint}${conn ? "｜" + conn : ""}`;
        els.topCurrentPlayer.title = `${turnOwnerName}`;
        els.topCurrentPlayer.classList.toggle("my-turn", !!myTurn);
        els.topCurrentPlayer.classList.toggle("not-my-turn", !myTurn && onlineSeatIndex != null);
      } else {
        els.topCurrentPlayer.textContent = turnOwnerName;
        els.topCurrentPlayer.classList.remove("my-turn", "not-my-turn");
      }
    }
    if (els.phaseBadge) els.phaseBadge.textContent = phaseText(gameState.phase);
    if (els.turnLine) els.turnLine.textContent = `第 ${gameState.turnNumber} 轮`;

    // v0.9.13: 底部仅保留 已捕捉 / 进化记录（token/减免/保留卡 由右侧玩家栏展示）
    if (els.tableauCards) {
      els.tableauCards.innerHTML = localP && localP.tableau.length
        ? localP.tableau.map((card) => renderCard(card, "tableau")).join("")
        : `<div class="muted">暂无</div>`;
    }
    if (els.evolvedArchive) {
      els.evolvedArchive.innerHTML = localP && localP.evolvedArchive.length
        ? localP.evolvedArchive.map((card) => renderCard(card, "tableau")).join("")
        : `<div class="muted">无</div>`;
    }

    // body class 切换 phase
    document.body.classList.remove("phase-discard", "phase-evolve", "phase-await");
    if (gameState.phase === "discard") document.body.classList.add("phase-discard");
    else if (gameState.phase === "evolve") document.body.classList.add("phase-evolve");
    else if (gameState.phase === "awaitAction") document.body.classList.add("phase-await");

    // v0.9.2 联机非自己回合：禁用供应区/操作按钮（视觉提示），但保留卡牌查看
    const onlineNotMyTurnFlag = onlineMode && onlineSeatIndex != null
      && gameState.currentPlayerIndex !== onlineSeatIndex
      && onlineSpectatorIndex == null;
    document.body.classList.toggle("online-not-my-turn", onlineNotMyTurnFlag);
  }

  function renderPlayersSidebar() {
    if (!els.playersSidebar || !gameState) return;
    const currentIdx = gameState.currentPlayerIndex;
    els.playersSidebar.innerHTML = gameState.players.map((player, idx) => {
      const isCurrent = idx === currentIdx && gameState.phase !== "gameOver";
      const reservedHtml = player.reserved.length > 0
        ? `<div class="sidebar-reserved-cards">
            ${player.reserved.map((card) => {
              const isOwn = idx === currentIdx;
              const classes = ["sidebar-reserved-card", isOwn ? "own" : "opponent"];
              return `
                <div class="${classes.join(" ")}" data-reserved-card-id="${escapeHtml(card.id)}" data-player-index="${idx}">
                  ${card.image ? buildImgTagWithFallback(getCardThumbnailPath(card.image), { alt: getCardName(card), loading: "lazy", decoding: "async", fallbackSrc: card.image }) : ""}
                  <div class="sidebar-reserved-card-name">${escapeHtml(getCardName(card))}</div>
                  <div class="sidebar-reserved-card-meta">${Number(card.points) || 0}分</div>
                </div>
              `;
            }).join("")}
          </div>`
        : `<div class="muted" style="font-size:10px;">保留：无</div>`;
      const tokenTotal = totalTokens(player.tokens);
      const discount = calculateDiscount(player);
      const discountTotal = NORMAL_COLORS.reduce((sum, c) => sum + (Number(discount[c]) || 0), 0);

      const tokenDetailHtml = ALL_COLORS.map((color) => {
        const count = player.tokens[color] || 0;
        return `<span class="mini-token ${color}${count === 0 ? " zero" : ""}" title="${TOKEN_LABELS[color]}">${count}</span>`;
      }).join("");

      const discountDetailHtml = NORMAL_COLORS.map((color) => {
        const count = discount[color] || 0;
        return `<span class="mini-discount ${color}${count === 0 ? " zero" : ""}" title="${TOKEN_LABELS[color]}">${count}</span>`;
      }).join("");

      return `
        <div class="player-sidebar-card ${isCurrent ? "is-current" : ""}">
          <div class="ps-header">
            <span class="ps-name">${escapeHtml(player.name)}</span>
            <span class="ps-tag ${player.isAI ? "ai" : ""} ${isCurrent ? "current" : ""}">
              ${isCurrent ? "行动中" : player.isAI ? "AI" : "人"}
            </span>
          </div>
          <div class="ps-score">${player.score}</div>
          <div class="sidebar-resource-section">
            <div class="sidebar-resource-label">token (${tokenTotal})</div>
            <div class="sidebar-resource-row">${tokenDetailHtml}</div>
          </div>
          <div class="sidebar-resource-section">
            <div class="sidebar-resource-label">减免 (${discountTotal})</div>
            <div class="sidebar-resource-row discount">${discountDetailHtml}</div>
          </div>
          <div class="ps-stats">
            <span>保留: <strong>${player.reserved.length}/3</strong></span>
            <span>已捕捉: <strong>${player.tableau.length}</strong></span>
            <span>进化: <strong>${player.evolvedArchive.length}</strong></span>
            <span>回合: <strong>${gameState.playerTurns[idx]}</strong></span>
          </div>
          ${reservedHtml}
        </div>
      `;
    }).join("");
  }

  function calculateDiscountCount(player) {
    const d = calculateDiscount(player);
    return ALL_COLORS.reduce((sum, c) => sum + (Number(d[c]) || 0), 0);
  }

  function renderSupplyColumn() {
    if (!els.supplyTokens || !gameState) return;
    const player = currentPlayer();
    const isAI = Boolean(player?.isAI);
    const isSpectator = Boolean(gameState?.spectatorMode);
    const canInteract = gameState.phase === "awaitAction" && !gameState.mainActionDone && !isAI && !isSpectator;

    // 如果不能交互，清空 pending 选择
    if (!canInteract && pendingTokenSelection.length > 0) {
      pendingTokenSelection = [];
    }

    els.supplyTokens.innerHTML = ALL_COLORS.map((color) => {
      const count = gameState.supply[color] || 0;
      const isPurple = color === "purple";
      const disabled = !canInteract || count <= 0 || isPurple;
      const bgUrl = `assets/tokens/${color}.png`;
      const selectedCount = pendingTokenSelection.filter((c) => c === color).length;
      const classes = ["supply-item"];
      if (isPurple) classes.push("purple-only");
      if (disabled && !isPurple) classes.push("disabled");
      if (selectedCount > 0) classes.push("selected");
      return `
        <div class="${classes.join(" ")}" data-supply-color="${color}" ${isPurple ? "title=\"大师球不能直接拿取\"" : ""}>
          <div class="token-icon-big" style="background-image:url('${bgUrl}')"></div>
          <div class="count">${count}${selectedCount > 0 ? ` <span class="selected-badge">×${selectedCount}</span>` : ""}</div>
          <div class="label">${TOKEN_LABELS[color]}</div>
        </div>
      `;
    }).join("");

    // 渲染 pending 提示和按钮
    renderPendingTokenUI(canInteract);
  }

  function renderPendingTokenUI(canInteract) {
    if (!els.pendingTokenHint || !els.pendingTokenActions) return;
    if (!canInteract || pendingTokenSelection.length === 0) {
      els.pendingTokenHint.innerHTML = "";
      els.pendingTokenActions.classList.add("hidden");
      return;
    }

    // 统计已选
    const countMap = {};
    pendingTokenSelection.forEach((c) => { countMap[c] = (countMap[c] || 0) + 1; });
    const hintText = Object.keys(countMap)
      .map((c) => `${TOKEN_LABELS[c]}×${countMap[c]}`)
      .join("，");
    els.pendingTokenHint.innerHTML = `已选：${escapeHtml(hintText)}`;

    // 判断是否可确认
    const canConfirm = validatePendingSelection();
    els.pendingTokenActions.classList.remove("hidden");
    if (els.confirmTokenSelectionButton) {
      els.confirmTokenSelectionButton.disabled = !canConfirm;
    }
  }

  function validatePendingSelection() {
    if (!gameState || pendingTokenSelection.length === 0) return false;
    const availableColors = NORMAL_COLORS.filter((color) => gameState.supply[color] > 0);
    const availableCount = availableColors.length;
    const countMap = {};
    pendingTokenSelection.forEach((c) => { countMap[c] = (countMap[c] || 0) + 1; });
    const usedColors = Object.keys(countMap);
    const maxCount = Math.max(...Object.values(countMap));

    // 拿 3 个不同球
    if (availableCount >= 3 && pendingTokenSelection.length === 3 && usedColors.length === 3) {
      return true;
    }
    // 只剩 2 种时的 2+1
    if (availableCount === 2 && pendingTokenSelection.length === 3 && usedColors.length === 2 && maxCount === 2) {
      return true;
    }
    // 拿 2 个相同球（supply >= 4）
    if (pendingTokenSelection.length === 2 && usedColors.length === 1) {
      const color = pendingTokenSelection[0];
      if (gameState.supply[color] >= 4) return true;
    }
    return false;
  }

  function handleSupplyClick(color) {
    if (!gameState || gameState.phase !== "awaitAction" || gameState.mainActionDone) return;
    const player = currentPlayer();
    if (!player || player.isAI || gameState.spectatorMode) return;
    if (onlineMode && !isOnlineLocalTurn()) { notify("还没轮到你。", "warn"); return; }
    if (color === "purple") return;
    if (gameState.supply[color] <= 0) return;

    const availableColors = NORMAL_COLORS.filter((c) => gameState.supply[c] > 0);
    const availableCount = availableColors.length;
    const countMap = {};
    pendingTokenSelection.forEach((c) => { countMap[c] = (countMap[c] || 0) + 1; });
    const usedColors = Object.keys(countMap);
    const currentCount = countMap[color] || 0;

    // 如果已选了这个颜色
    if (currentCount > 0) {
      // 已选 2 个同色 → 取消最后一个（toggle off）
      if (currentCount >= 2) {
        for (let i = pendingTokenSelection.length - 1; i >= 0; i--) {
          if (pendingTokenSelection[i] === color) {
            pendingTokenSelection.splice(i, 1);
            break;
          }
        }
        renderSupplyColumn();
        return;
      }
      // currentCount === 1：尝试加第二个同色（拿 2 个相同球，需要 supply >= 4）
      if (gameState.supply[color] >= 4 && pendingTokenSelection.length < 3) {
        // 如果当前已有其他颜色的选择，不允许混选（2同球必须只有一种颜色）
        if (usedColors.length === 1) {
          pendingTokenSelection.push(color);
          renderSupplyColumn();
          return;
        }
        // 有多种颜色时，先取消再加——但更简单：直接不允许，让用户先清空
        // 这里改为：取消该颜色的选择（toggle off）
      }
      // supply < 4 或已有多种颜色 → 取消该颜色选择
      for (let i = pendingTokenSelection.length - 1; i >= 0; i--) {
        if (pendingTokenSelection[i] === color) {
          pendingTokenSelection.splice(i, 1);
          break;
        }
      }
      renderSupplyColumn();
      return;
    }

    // 新增选择
    if (pendingTokenSelection.length >= 3) return; // 最多 3 个

    // 检查是否允许选这个颜色
    if (availableCount >= 3) {
      // >= 3 种：可以选不同颜色，也可以选同色两次（supply>=4 时拿2同球）
      if (usedColors.includes(color)) {
        // 已有此颜色，允许选第二次（仅当 supply >= 4）
        if (gameState.supply[color] >= 4 && currentCount < 2) {
          pendingTokenSelection.push(color);
        }
      } else {
        // 新颜色
        if (usedColors.length < 3) {
          pendingTokenSelection.push(color);
        }
      }
      renderSupplyColumn();
      return;
    } else if (availableCount === 2) {
      // 2 种：2+1 模式
      if (usedColors.length === 0) {
        pendingTokenSelection.push(color);
      } else if (usedColors.length === 1) {
        if (usedColors[0] === color) {
          // 同色第二个
          if (gameState.supply[color] >= 4) {
            pendingTokenSelection.push(color);
          }
        } else {
          pendingTokenSelection.push(color);
        }
      } else if (usedColors.length === 2) {
        // 已有两种，加第三个（必须是已有的某一种）
        if (usedColors.includes(color)) {
          pendingTokenSelection.push(color);
        }
      }
      renderSupplyColumn();
      return;
    } else if (availableCount === 1) {
      // 只剩 1 种：只能拿 2 个相同（supply >= 4）
      if (gameState.supply[color] >= 4 && pendingTokenSelection.length < 2) {
        pendingTokenSelection.push(color);
      }
      renderSupplyColumn();
      return;
    }
  }

  function confirmTokenSelection() {
    if (!validatePendingSelection()) return;
    const countMap = {};
    pendingTokenSelection.forEach((c) => { countMap[c] = (countMap[c] || 0) + 1; });
    const usedColors = Object.keys(countMap);
    const maxCount = Math.max(...Object.values(countMap));

    pushHistorySnapshot();
    if (pendingTokenSelection.length === 2 && usedColors.length === 1) {
      // 拿 2 个相同球
      performTakeTwoSameTokens(gameState.currentPlayerIndex, pendingTokenSelection[0]);
    } else {
      // 拿 3 个不同球（含 2+1）
      performTakeDifferentTokens(gameState.currentPlayerIndex, [...pendingTokenSelection]);
    }
    pendingTokenSelection = [];
  }

  function clearTokenSelection() {
    pendingTokenSelection = [];
    renderSupplyColumn();
  }

  function renderActionLog() {
    if (!els.actionLogContent || !gameState) return;
    const logs = gameState.actionLog || [];
    // 显示最后 60 条（UI 上保留显示）
    const recent = logs.slice(-60);
    els.actionLogContent.innerHTML = recent.map((entry) => {
      const isAI = /AI/.test(entry.player || "");
      const cls = isAI ? "ai" : "";
      return `<div class="action-log-entry ${cls}">
        <span class="muted" style="font-size:10px;">T${entry.turn ?? "?"}</span>
        <strong>${escapeHtml(entry.player || "")}</strong>
        ${escapeHtml(entry.message)}
      </div>`;
    }).join("") || `<div class="muted">暂无记录</div>`;
    // 自动滚动到底部
    els.actionLogContent.scrollTop = els.actionLogContent.scrollHeight;
  }

  function renderBoard() {
    const player = currentPlayer();
    const isAI = Boolean(player?.isAI);
    const isSpectator = Boolean(gameState?.spectatorMode);
    const canAct = gameState.phase === "awaitAction" && !gameState.mainActionDone && !isAI && !isSpectator;
    const reservedFull = player && player.reserved.length >= 3;

    const normalRows = ["level3", "level2", "level1"].map((key) => {
      const cards = gameState.market[key];
      const deckCount = gameState.decks[key].length;
      const canBlindReserve = canAct && deckCount > 0 && !reservedFull;
      return `
        <section class="market-row">
          <div class="market-heading">
            <h3>${MARKET_LABELS[key]}卡</h3>
            <span class="market-pile ${canBlindReserve ? "clickable" : ""}" ${canBlindReserve ? `data-blind-reserve="${key}" title="点击盲抽保留"` : ""}>牌堆 ${deckCount}${canBlindReserve ? " ▸" : ""}</span>
          </div>
          <div class="card-grid">
            ${cards.length ? cards.map((card) => renderCard(card, "market", key)).join("") : `<div class="muted">无可展示卡</div>`}
          </div>
        </section>
      `;
    }).join("");

    const rareCard = gameState.market.rare[0];
    const legendCard = gameState.market.legend[0];

    const specialBoard = `
      <div class="special-board">
        <div class="special-slot">
          <h4>稀有 (${gameState.decks.rare.length})</h4>
          ${rareCard ? renderCard(rareCard, "market", "rare") : `<div class="muted">无</div>`}
        </div>
        <div class="special-slot">
          <h4>传说 (${gameState.decks.legend.length})</h4>
          ${legendCard ? renderCard(legendCard, "market", "legend") : `<div class="muted">无</div>`}
        </div>
      </div>
    `;

    els.publicBoard.innerHTML = `
      <div class="card-legend">
        <span class="legend-item buy">可捕捉</span>
        <span class="legend-item evolve-target">可进化目标</span>
        <span class="legend-item evolve-base">可进化基础</span>
        <span class="legend-item disabled">暂不可捕捉</span>
      </div>
      <div class="normal-board">
        ${normalRows}
      </div>
    ` + specialBoard;
  }

  function renderActions() {
    const player = currentPlayer();
    const isAI = Boolean(player?.isAI);
    const isSpectator = Boolean(gameState?.spectatorMode);
    const actionEnabled = gameState.phase === "awaitAction" && !gameState.mainActionDone && !isAI && !isSpectator;
    renderTakeControls(actionEnabled);
    renderSelectedInfo(player);
    renderDiscardPanel(player);
    renderEvolveOptions(player);

    els.takeThreeButton.disabled = !actionEnabled;
    els.takeTwoButton.disabled = !actionEnabled;
    els.reserveSelectedButton.disabled = !actionEnabled;
    els.blindReserveButton.disabled = !actionEnabled;
    els.buySelectedButton.disabled = !actionEnabled;
    els.skipEvolutionButton.disabled = gameState.phase !== "evolve" || isAI;
    if (els.undoButton) els.undoButton.disabled = !historyStack.length || isAI;
  }

  function renderTakeControls(actionEnabled) {
    const availableColors = NORMAL_COLORS.filter((color) => gameState.supply[color] > 0);
    const availableCount = availableColors.length;
    const legalTakeDifferentActions = getLegalTakeDifferentTokenActionsFromSupply(gameState.supply);

    if (availableCount >= 3) {
      // >= 3 种可用：显示复选框，选 3 种不同颜色
      els.takeThreeChoices.innerHTML = `<div class="take-three-checkboxes">${NORMAL_COLORS.map((color) => `
        <label>
          <input type="checkbox" name="takeThree" value="${color}" ${actionEnabled && gameState.supply[color] > 0 ? "" : "disabled"}>
          ${TOKEN_LABELS[color]} (${gameState.supply[color]})
        </label>
      `).join("")}</div>`;
      els.takeThreeButton.textContent = "拿 3 个不同球";
      els.takeThreeButton.style.display = "";
    } else if (legalTakeDifferentActions.length > 0) {
      // 2 种可用：显示合法的 2+1 按钮
      els.takeThreeChoices.innerHTML = `
        <div class="take-three-buttons">
          ${legalTakeDifferentActions.map((action) => {
            const countMap = {};
            action.colors.forEach((color) => { countMap[color] = (countMap[color] || 0) + 1; });
            const label = Object.keys(countMap)
              .map((color) => `拿 ${countMap[color]} 个${TOKEN_LABELS[color]}`)
              .join(" + ");
            return `
              <button type="button" class="take-three-two-one-btn" data-colors="${action.colors.join(",")}" ${actionEnabled ? "" : "disabled"}>
                ${label}
              </button>
            `;
          }).join("")}
        </div>
      `;
      els.takeThreeButton.style.display = "none";
    } else {
      // <= 1 种可用：禁用
      els.takeThreeChoices.innerHTML = `<div class="muted">可用普通球不足 2 种，不能执行此行动。</div>`;
      els.takeThreeButton.textContent = "拿 3 个不同球";
      els.takeThreeButton.style.display = "";
      els.takeThreeButton.disabled = true;
    }

    els.takeTwoColor.innerHTML = NORMAL_COLORS.map((color) => `
      <option value="${color}">${TOKEN_LABELS[color]} (${gameState.supply[color]})</option>
    `).join("");
  }

  function renderSelectedCardOnlyHtml(ref) {
    const imageHtml = ref.card.image
      ? buildImgTagWithFallback(getCardThumbnailPath(ref.card.image), { className: "selected-card-img", alt: getCardName(ref.card), loading: "lazy", decoding: "async", fallbackSrc: ref.card.image })
      : "";
    return `
      <hr style="margin: 10px 0; border: none; border-top: 1px solid var(--line);">
      ${imageHtml}
      <strong>${escapeHtml(getCardName(ref.card))}</strong>
      <div class="card-line">${escapeHtml(cardTypeText(ref.card))}</div>
    `;
  }

  function renderSelectedInfo(player) {
    const ref = getSelectedCardRef();
    const isAI = Boolean(player?.isAI);
    const isSpectator = Boolean(gameState?.spectatorMode);
    const canAct = gameState.phase === "awaitAction" && !gameState.mainActionDone && !isAI && !isSpectator;

    // v0.9.1 联机模式：非本地玩家回合时，显示等待提示（也覆盖 phase 提示）
    const onlineNotMyTurn = onlineMode && onlineSeatIndex != null && gameState.currentPlayerIndex !== onlineSeatIndex;
    if (onlineNotMyTurn && onlineSpectatorIndex == null) {
      const actingPlayer = currentPlayer();
      const actingName = actingPlayer?.name || "其他玩家";
      let phaseHint = "";
      if (gameState.phase === "discard") phaseHint = `，${actingName} 正在丢弃 token`;
      else if (gameState.phase === "evolve") phaseHint = `，${actingName} 正在选择进化`;
      els.selectedCardInfo.innerHTML = `
        <div class="selected-card-hint cannot">当前不是你的回合</div>
        <div class="card-line">请等待 <strong>${escapeHtml(actingName)}</strong> 操作${phaseHint}。</div>
        ${ref ? renderSelectedCardOnlyHtml(ref) : ""}
      `;
      return;
    }
    if (onlineSpectatorIndex != null) {
      const actingPlayer = currentPlayer();
      const actingName = actingPlayer?.name || "—";
      els.selectedCardInfo.innerHTML = `
        <div class="selected-card-hint info">观战模式</div>
        <div class="card-line">当前 <strong>${escapeHtml(actingName)}</strong> 的回合。</div>
        ${ref ? renderSelectedCardOnlyHtml(ref) : ""}
      `;
      return;
    }

    // 进化阶段提示
    if (gameState.phase === "evolve") {
      const options = getEvolveOptions(player);
      let evolveHtml = `
        <div class="selected-card-hint info">进化阶段</div>
        ${options.length > 0 ? `<div class="card-line">可进化 ${options.length} 项，点击金色卡牌完成进化</div>` : `<div class="card-line muted">当前无可进化选项</div>`}
        <div class="selected-card-actions">
          <button type="button" class="skip-evolve-btn" ${isAI ? "disabled" : ""}>跳过进化 / 结束回合</button>
        </div>
      `;
      // 如果有选中卡，也显示详情
      if (ref) {
        const imageHtml = ref.card.image
          ? buildImgTagWithFallback(getCardThumbnailPath(ref.card.image), { className: "selected-card-img", alt: getCardName(ref.card), loading: "lazy", decoding: "async", fallbackSrc: ref.card.image })
          : "";
        evolveHtml = `
          ${imageHtml}
          <strong>${escapeHtml(getCardName(ref.card))}</strong>
          <div class="card-line">${escapeHtml(cardTypeText(ref.card))}</div>
        ` + evolveHtml;
      }
      els.selectedCardInfo.innerHTML = evolveHtml;
      return;
    }

    // 丢弃阶段提示
    if (gameState.phase === "discard") {
      const needDiscard = Math.max(0, totalTokens(player.tokens) - 10);
      els.selectedCardInfo.innerHTML = `
        <div class="selected-card-hint cannot">token 超限</div>
        <div class="card-line">当前 ${totalTokens(player.tokens)} 个，还需丢弃 ${needDiscard} 个。</div>
        <div class="card-line muted">点击底部你的 token 进行丢弃。</div>
      `;
      return;
    }

    if (!ref) {
      const hint = canAct
        ? `<div class="selected-card-hint info">点击公共区卡牌查看详情</div>`
        : "";
      els.selectedCardInfo.innerHTML = hint || "未选择";
      return;
    }

    // 其他玩家的保留卡：只显示信息，不可操作
    if (ref.source === "opponentReserved") {
      const ownerName = gameState.players[ref.ownerIndex]?.name || "其他玩家";
      const imageHtml = ref.card.image
        ? buildImgTagWithFallback(getCardThumbnailPath(ref.card.image), { className: "selected-card-img", alt: getCardName(ref.card), loading: "lazy", decoding: "async", fallbackSrc: ref.card.image })
        : "";
      els.selectedCardInfo.innerHTML = `
        ${imageHtml}
        <strong>${escapeHtml(getCardName(ref.card))}</strong>
        <div class="card-line">${escapeHtml(cardTypeText(ref.card))} / ${escapeHtml(ownerName)} 的保留卡</div>
        ${ref.card.points ? `<div class="card-line">分数：${ref.card.points}</div>` : ""}
        ${ref.card.bonus ? `<div class="card-line">减免：${bonusText(ref.card)}</div>` : ""}
        <div class="cost-line">
          <strong>原始费用</strong>
          <div class="token-icon-row">${renderTokenIcons(ref.card.cost, { size: "medium" })}</div>
        </div>
        <div class="selected-card-hint info">这是其他玩家的保留卡，不能操作。</div>
        <div class="selected-card-actions">
          <button type="button" data-action="preview-selected">查看大图</button>
        </div>
      `;
      return;
    }

    const info = getPayInfo(player, ref.card);
    const rawCost = normalizeTokens(ref.card.cost);
    const canReserve = canAct && ref.source === "market" && ["level1", "level2", "level3"].includes(ref.marketKey) && player.reserved.length < 3;
    const reserveDisabled = canAct && ref.source === "market" && ["level1", "level2", "level3"].includes(ref.marketKey) && player.reserved.length >= 3;
    const requiredPurpleOnly = Math.max(0, rawCost.purple - info.discount.purple);
    const usesPurpleAsSubstitute = info.payable && info.payCost.purple > requiredPurpleOnly;
    const imageHtml = ref.card.image
      ? buildImgTagWithFallback(getCardThumbnailPath(ref.card.image), { className: "selected-card-img", alt: getCardName(ref.card), loading: "lazy", decoding: "async", fallbackSrc: ref.card.image })
      : "";

    // 操作按钮
    let actionsHtml = '<div class="selected-card-actions">';
    // 捕捉按钮
    if (canAct && info.payable) {
      actionsHtml += `<button type="button" class="buy-btn" data-action="buy-selected">捕捉</button>`;
    } else if (canAct) {
      actionsHtml += `<button type="button" class="buy-btn" disabled>token 不足</button>`;
    }
    // 保留按钮
    if (canReserve) {
      actionsHtml += `<button type="button" class="reserve-btn" data-action="reserve-selected">保留</button>`;
    } else if (reserveDisabled) {
      actionsHtml += `<button type="button" class="reserve-btn" disabled>保留区已满 ${player.reserved.length}/3</button>`;
    }
    // 查看大图
    actionsHtml += `<button type="button" data-action="preview-selected">查看大图</button>`;
    actionsHtml += '</div>';

    els.selectedCardInfo.innerHTML = `
      ${imageHtml}
      <strong>${escapeHtml(getCardName(ref.card))}</strong>
      <div class="card-line">${escapeHtml(cardTypeText(ref.card))} / ${ref.source === "reserved" ? "保留区" : "公共区"}</div>
      ${ref.card.points ? `<div class="card-line">分数：${ref.card.points}</div>` : ""}
      ${ref.card.bonus ? `<div class="card-line">减免：${bonusText(ref.card)}</div>` : ""}
      <div class="cost-breakdown">
        <div class="cost-line">
          <strong>原始费用</strong>
          <div class="token-icon-row">${renderTokenIcons(ref.card.cost, { size: "medium" })}</div>
        </div>
        <div class="cost-line">
          <strong>当前减免</strong>
          <div class="token-icon-row">${renderTokenIcons(info.discount, { size: "medium", includeZero: true })}</div>
        </div>
        <div class="cost-line">
          <strong>实际支付</strong>
          <div class="token-icon-row">${info.payable ? renderTokenIcons(info.payCost, { size: "medium", includeZero: true }) : `<span class="muted">token 不足</span>`}</div>
        </div>
      </div>
      ${usesPurpleAsSubstitute ? `<div class="purple-substitute-note">大师球将补足普通球不足。</div>` : ""}
      <div class="selected-card-hint ${info.payable ? "can" : "cannot"}">
        ${info.payable ? "可以捕捉" : "暂不能捕捉：token 不足"}
      </div>
      ${actionsHtml}
    `;
  }

  function renderDiscardPanel(player) {
    const needDiscard = Math.max(0, totalTokens(player.tokens) - 10);
    setVisible(els.discardPanel, gameState.phase === "discard");
    els.discardHint.textContent = `当前 ${totalTokens(player.tokens)} 个，还需丢弃 ${needDiscard} 个。`;
    els.discardButtons.innerHTML = ALL_COLORS.map((color) => `
      <button type="button" data-discard-color="${color}" ${player.tokens[color] > 0 ? "" : "disabled"}>
        丢 1 个${TOKEN_LABELS[color]} (${player.tokens[color]})
      </button>
    `).join("");
  }

  function renderEvolveOptions(player) {
    const options = getEvolveOptions(player);
    if (gameState.phase !== "evolve") {
      els.evolveOptions.innerHTML = `<div class="muted">完成主要行动后进入进化阶段</div>`;
      return;
    }
    if (!options.length) {
      els.evolveOptions.innerHTML = `<div class="muted">当前没有可进化选项，可跳过</div>`;
      return;
    }
    // 精简提示：不展开列表，只显示数量
    els.evolveOptions.innerHTML = `<div class="muted">可进化 ${options.length} 项，点击金色卡牌完成进化</div>`;
  }

  function renderFinalScreen() {
    setVisible(els.finalScreen, Boolean(gameState?.gameOver));
    if (!gameState?.gameOver) return;

    const ranking = rankPlayers();
    const winner = ranking[0]?.player;

    els.finalRanking.innerHTML = `
      <div class="final-summary">
        <h2>游戏结束</h2>
        ${gameState.stalemate ? `<p class="stalemate-notice">游戏停滞结算：当前没有玩家可执行合法主行动，按当前分数排名。</p>` : ""}
        <div class="winner-card">
          <div class="winner-badge">冠军</div>
          <h3>${escapeHtml(winner.name)}</h3>
          <p>${winner.score} 分</p>
        </div>
        <p class="muted">平局规则：先比分数，再比进化记录数量，再比正面宝可梦数量。</p>
      </div>

      <div class="final-ranking-list">
        ${ranking.map((entry, index) => {
          const player = entry.player;
          return `
            <section class="final-player-card ${index === 0 ? "winner" : ""}">
              <div class="final-player-header">
                <div class="rank-number">#${index + 1}</div>
                <div>
                  <h3>${escapeHtml(player.name)}</h3>
                  <p class="muted">${index === 0 ? "胜利者" : "排名"}</p>
                </div>
              </div>

              <div class="final-stats">
                <div><strong>${player.score}</strong><span>分数</span></div>
                <div><strong>${player.evolvedArchive.length}</strong><span>进化</span></div>
                <div><strong>${player.tableau.length}</strong><span>正面宝可梦</span></div>
                <div><strong>${player.reserved.length}</strong><span>保留卡</span></div>
                <div><strong>${totalTokens(player.tokens)}</strong><span>剩余 token</span></div>
              </div>

              <div class="final-section">
                <h4>已捕捉宝可梦</h4>
                <div class="final-card-strip">
                  ${player.tableau.length
                    ? player.tableau.map((card) => `
                        <div class="final-mini-card" title="${escapeHtml(getCardName(card))}">
                          ${card.image ? `<img src="${escapeHtml(card.image)}" alt="${escapeHtml(getCardName(card))}" loading="lazy">` : ""}
                          <span>${escapeHtml(getCardName(card))}</span>
                        </div>
                      `).join("")
                    : `<span class="muted">无</span>`
                  }
                </div>
              </div>

              <div class="final-section">
                <h4>进化记录</h4>
                <div class="final-card-strip">
                  ${player.evolvedArchive.length
                    ? player.evolvedArchive.map((card) => `
                        <div class="final-mini-card evolved" title="${escapeHtml(getCardName(card))}">
                          ${card.image ? `<img src="${escapeHtml(card.image)}" alt="${escapeHtml(getCardName(card))}" loading="lazy">` : ""}
                          <span>${escapeHtml(getCardName(card))}</span>
                        </div>
                      `).join("")
                    : `<span class="muted">无</span>`
                  }
                </div>
              </div>
            </section>
          `;
        }).join("")}
      </div>

      <div class="final-actions">
        <button id="finalRestartButton" type="button" class="primary">再来一局</button>
        <button id="finalCloseButton" type="button" class="ghost">返回游戏</button>
      </div>
    `;
  }

  function renderDebug() {
    els.debugCardSelect.innerHTML = cardDatabase.map((card) => `
      <option value="${escapeHtml(card.id)}">${escapeHtml(getCardName(card))} (${escapeHtml(cardTypeText(card))})</option>
    `).join("");

    const summary = {
      currentPlayerIndex: gameState.currentPlayerIndex,
      turnNumber: gameState.turnNumber,
      phase: gameState.phase,
      playerTurns: gameState.playerTurns,
      decksRemaining: Object.fromEntries(MARKET_KEYS.map((key) => [key, gameState.decks[key].length])),
      finalRoundTriggered: gameState.finalRoundTriggered,
      finalTriggerPlayerIndex: gameState.finalTriggerPlayerIndex,
      finalTargetTurnCount: gameState.finalTargetTurnCount,
      gameStateSummary: {
        supply: gameState.supply,
        players: gameState.players.map((player) => ({
          name: player.name,
          score: player.score,
          tokens: player.tokens,
          reserved: player.reserved.length,
          tableau: player.tableau.length,
          evolvedArchive: player.evolvedArchive.length
        })),
        selectedCard: gameState.selectedCard
      }
    };
    els.debugContent.textContent = JSON.stringify(summary, null, 2);
  }

  function renderTokens(tokens, includeZero = false) {
    return ALL_COLORS
      .filter((color) => includeZero || (Number(tokens[color]) || 0) > 0)
      .map((color) => `<span class="token ${color}" data-token-color="${color}" data-player-token-color="${color}">${TOKEN_LABELS[color]} ${Number(tokens[color]) || 0}</span>`)
      .join("") || `<span class="muted">无</span>`;
  }

  function getCardVisualClasses(card, source, marketKey) {
    const classes = ["card"];
    const player = currentPlayer();
    const isSelected = gameState?.selectedCard
      && gameState.selectedCard.source === source
      && gameState.selectedCard.cardId === card.id
      && (source !== "market" || gameState.selectedCard.marketKey === marketKey);
    if (isSelected) classes.push("selected");
    if (player && gameState?.phase === "awaitAction" && (source === "market" || source === "reserved")) {
      if (canBuy(player, card)) {
        classes.push("can-buy");
      } else {
        classes.push("cannot-buy");
      }
    }
    if (player && gameState?.phase === "evolve") {
      const options = getEvolveOptions(player);
      if (options.some((option) => option.targetCard.id === card.id)) {
        classes.push("can-evolve-target");
      }
      if (options.some((option) => option.baseCard.id === card.id)) {
        classes.push("can-evolve-base");
      }
    }
    return classes.join(" ");
  }

  function renderCard(card, source, marketKey = "") {
    const selectable = source === "market" || source === "reserved";
    const dataAttrs = selectable
      ? `data-card-id="${escapeHtml(card.id)}" data-card-source="${source}" data-market-key="${marketKey}"`
      : "";
    // v0.9.5.2 公共区 compact 模式：source === "market" 时只渲染卡图，文字详情交给 selected-card-panel
    // reserved / tableau 保持原有完整渲染，不受影响
    if (source === "market") {
      const cardName = getCardName(card);
      const cardTypeLabel = cardTypeText(card);
      const points = Number(card.points) || 0;
      // 轻量 tooltip：仅 hover 时显示卡名 + 等级 + 分数
      const tooltip = `${cardName} | ${cardTypeLabel}${points ? ` | ${points}分` : ""}`;
      return `
        <article class="${getCardVisualClasses(card, source, marketKey)}" ${dataAttrs} title="${escapeHtml(tooltip)}">
          ${card.image ? buildImgTagWithFallback(getCardThumbnailPath(card.image), { className: "card-image", alt: cardName, loading: "lazy", decoding: "async", fallbackSrc: card.image }) : ""}
        </article>
      `;
    }
    return `
      <article class="${getCardVisualClasses(card, source, marketKey)}" ${dataAttrs}>
        ${card.image ? buildImgTagWithFallback(getCardThumbnailPath(card.image), { className: "card-image", alt: getCardName(card), loading: "lazy", decoding: "async", fallbackSrc: card.image }) : ""}
        <div class="card-name">
          <span>${escapeHtml(getCardName(card))}</span>
          <span>${Number(card.points) || 0} 分</span>
        </div>
        <div class="card-meta">${escapeHtml(cardTypeText(card))}${card.name_en ? ` / ${escapeHtml(card.name_en)}` : ""}</div>
        <div class="card-line">
          <span>减免：</span>
          <span class="token-icon-row">${renderBonusIcon(card)}</span>
        </div>
        <div class="card-line">
          <span>费用：</span>
          <span class="token-icon-row">${renderTokenIcons(card.cost)}</span>
        </div>
        <div class="card-line">进化为：${escapeHtml(card.evolvesTo || "无")}</div>
        <div class="card-line">
          <span>进化条件：</span>
          <span class="token-icon-row">${renderTokenIcons(card.evolveCost)}</span>
        </div>
        <button type="button" class="preview-card-button" data-preview-card-id="${escapeHtml(card.id)}">查看大图</button>
      </article>
    `;
  }

  function phaseText(phase) {
    return {
      awaitAction: "主要行动",
      discard: "丢弃 token",
      evolve: "进化阶段",
      gameOver: "已结束"
    }[phase] || phase;
  }

  // =============================
  // 事件绑定
  // =============================
  function cacheElements() {
    [
      "cardDataStatus", "restartButton", "messageBar", "loadScreen", "cardFileInput",
      "startScreen", "playerCount", "aiCount", "aiTypeSelect", "startButton", "gameScreen",
      "phaseBadge",
      "tableauCards", "publicBoard", "turnLine", "supplyTokens", "selectedCardInfo",
      "takeThreeChoices", "takeThreeButton", "takeTwoColor", "takeTwoButton",
      "reserveSelectedButton", "blindDeck", "blindReserveButton", "buySelectedButton",
      "undoButton",
      "discardPanel", "discardHint", "discardButtons", "skipEvolutionButton",
      "evolveOptions", "finalScreen", "finalRanking", "debugPanel", "debugContent",
      "debugCardSelect", "debugAddToTableau", "debugAddToReserved",
      "debugTokenRed", "debugTokenBlue", "debugTokenBlack", "debugTokenPink",
      "debugTokenYellow", "debugTokenPurple", "debugClearTokens", "debugAddManyTokens",
      "debugRefreshScore", "debugClearPlayerCards", "debugForceEvolve",
      "debugForceEndTurn", "debugClearStorage",
      "cardPreviewModal", "cardPreviewContent", "closeCardPreviewButton",
      "rulesButton", "rulesModal", "closeRulesButton",
      "toggleAIPauseButton", "aiStepButton", "aiSpeedSelect", "aiSpeedRow", "spectatorNotice",
      // v0.7 新增 DOM
      "roomBadge", "topCurrentPlayer",
      "playersSidebar", "actionLogContent", "evolvedArchive",
      "pendingTokenHint", "pendingTokenActions", "confirmTokenSelectionButton", "clearTokenSelectionButton",
      // v0.9.0 联机模式 DOM
      "modeLocalBtn", "modeOnlineBtn", "localPanel", "onlinePanel", "onlineLobby",
      "onlineCreateName", "onlinePlayerCount", "onlineAICount", "createRoomButton",
      "onlineJoinName", "onlineRoomCode", "joinRoomButton",
      "lobbyRoomCode", "lobbyPlayerList", "startOnlineGameButton", "leaveRoomButton", "lobbyStatus",
      // v0.9.2 联机入口体验 DOM
      "lobbyJoinAddress", "lobbyCopyRoomCodeButton", "lobbyCopyJoinLinkButton",
      "lobbyLanHint", "howToConnectButton", "howToConnectModal", "closeHowToConnectButton"
    ].forEach((id) => {
      els[id] = $(id);
    });
  }

  function bindEvents() {
    els.playerCount.addEventListener("change", () => {
      const maxAI = Number(els.playerCount.value);
      Array.from(els.aiCount.options).forEach((opt) => {
        opt.disabled = Number(opt.value) > maxAI;
      });
      if (Number(els.aiCount.value) > maxAI) {
        els.aiCount.value = maxAI;
      }
    });

    els.startButton.addEventListener("click", () => {
      startNewGame(Number(els.playerCount.value));
    });

    els.restartButton.addEventListener("click", () => {
      // P0-2 修复：联机模式禁用本地重新开始（防状态分叉）
      if (onlineMode) { notify("联机模式不支持本地重新开始，如需新局请新建房间。", "warn"); return; }
      if (gameState && !window.confirm("确认清除当前存档并回到开始界面？")) return;
      clearAISchedule();
      clearSavedGame();
      gameState = null;
      historyStack = [];
      notify("存档已清除。", "info");
      render();
    });

    els.cardFileInput.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await loadCardDataFromFile(file);
        notify(`已读取 ${cardDatabase.length} 张卡牌。`, "info");
        render();
      } catch (error) {
        notify(`读取 cards.json 失败：${error.message}`, "error");
      }
    });

    els.takeThreeButton.addEventListener("click", () => {
      const availableColors = NORMAL_COLORS.filter((color) => gameState.supply[color] > 0);
      if (availableColors.length >= 3) {
        const colors = [...els.takeThreeChoices.querySelectorAll("input[name='takeThree']:checked")]
          .map((input) => input.value);
        takeThreeDifferentTokens(colors);
      }
    });

    els.takeTwoButton.addEventListener("click", () => {
      takeTwoSameTokens(els.takeTwoColor.value);
    });

    els.reserveSelectedButton.addEventListener("click", reserveSelectedCard);
    els.blindReserveButton.addEventListener("click", () => blindReserve(els.blindDeck.value));
    els.buySelectedButton.addEventListener("click", buySelectedCard);
    if (els.undoButton) els.undoButton.addEventListener("click", () => {
      // P0-2 修复：联机模式禁用本地撤销（防状态分叉）
      if (onlineMode) { notify("联机模式不支持本地撤销。", "warn"); return; }
      undoLastAction();
    });
    els.skipEvolutionButton.addEventListener("click", skipEvolution);

    if (els.confirmTokenSelectionButton) {
      els.confirmTokenSelectionButton.addEventListener("click", confirmTokenSelection);
    }
    if (els.clearTokenSelectionButton) {
      els.clearTokenSelectionButton.addEventListener("click", clearTokenSelection);
    }

    document.addEventListener("click", (event) => {
      const discardButton = event.target.closest("[data-discard-color]");
      if (discardButton) {
        discardToken(discardButton.dataset.discardColor);
        return;
      }

      // selected-card-panel 操作按钮
      const actionBtn = event.target.closest("[data-action]");
      if (actionBtn) {
        event.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === "buy-selected") buySelectedCard();
        else if (action === "reserve-selected") reserveSelectedCard();
        else if (action === "preview-selected") {
          const ref = getSelectedCardRef();
          if (ref) openCardPreview(ref.card.id);
        }
        return;
      }

      // 跳过进化按钮（selected-card-panel 内）
      const skipEvolveBtn = event.target.closest(".skip-evolve-btn");
      if (skipEvolveBtn) {
        skipEvolution();
        return;
      }

      // 盲抽保留（点击牌堆）
      const blindReserveEl = event.target.closest("[data-blind-reserve]");
      if (blindReserveEl) {
        if (!requireActionPhase()) return;
        pushHistorySnapshot();
        performReserveDeckTop(gameState.currentPlayerIndex, blindReserveEl.dataset.blindReserve);
        return;
      }

      const evolveButton = event.target.closest("[data-evolve-base]");
      if (evolveButton) {
        evolveAndEndTurn(evolveButton.dataset.evolveBase, evolveButton.dataset.evolveTarget);
        return;
      }

      const previewButton = event.target.closest("[data-preview-card-id]");
      if (previewButton) {
        event.stopPropagation();
        openCardPreview(previewButton.dataset.previewCardId);
        return;
      }

      // 2 种球时的 2+1 按钮（legacy，可能已隐藏但仍可触发）
      const takeTwoOneBtn = event.target.closest(".take-three-two-one-btn");
      if (takeTwoOneBtn) {
        const colors = takeTwoOneBtn.dataset.colors.split(",");
        takeThreeDifferentTokens(colors);
        return;
      }

      // 供应区球点击
      const supplyItem = event.target.closest("[data-supply-color]");
      if (supplyItem) {
        handleSupplyClick(supplyItem.dataset.supplyColor);
        return;
      }

      // 丢弃阶段：点击自己的 token
      const tokenItem = event.target.closest("[data-player-token-color]");
      if (tokenItem) {
        if (gameState.phase === "discard") {
          discardToken(tokenItem.dataset.playerTokenColor);
        }
        return;
      }

      // 右侧玩家栏保留卡点击
      const sidebarReservedCard = event.target.closest("[data-reserved-card-id]");
      if (sidebarReservedCard && gameState && gameState.phase !== "gameOver") {
        const cardId = sidebarReservedCard.dataset.reservedCardId;
        const ownerIdx = Number(sidebarReservedCard.dataset.playerIndex);
        if (ownerIdx === gameState.currentPlayerIndex) {
          // 自己的保留卡
          setSelectedCard("reserved", cardId, "", ownerIdx);
        } else {
          // 其他玩家的保留卡，只查看
          setSelectedCard("opponentReserved", cardId, "", ownerIdx);
        }
        return;
      }

      // 卡牌点击
      const card = event.target.closest("[data-card-id]");
      if (card && gameState && gameState.phase !== "gameOver") {
        // 进化阶段：点击金色可进化目标卡直接执行进化
        if (gameState.phase === "evolve") {
          handleEvolveCardClick(card.dataset.cardId, card.dataset.cardSource, card.dataset.marketKey || "");
          return;
        }
        setSelectedCard(card.dataset.cardSource, card.dataset.cardId, card.dataset.marketKey || "");
      }
    });

    document.addEventListener("error", (event) => {
      if (event.target?.classList?.contains("card-image")) {
        event.target.remove();
      }
    }, true);

    document.querySelectorAll(".card-size-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const size = btn.dataset.cardSize;
        document.body.className = document.body.className
          .replace(/card-size-\w+/g, "")
          .trim();
        document.body.classList.add(`card-size-${size}`);
        document.querySelectorAll(".card-size-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    const cardSizeSelect = document.getElementById("cardSizeSelect");

    function setCardSize(size) {
      document.body.classList.remove("card-size-small", "card-size-medium", "card-size-large");
      document.body.classList.add(`card-size-${size}`);
      localStorage.setItem("pokemonSplendorCardSize", size);
    }

    if (cardSizeSelect) {
      const savedSize = localStorage.getItem("pokemonSplendorCardSize") || "medium";
      cardSizeSelect.value = savedSize;
      setCardSize(savedSize);

      cardSizeSelect.addEventListener("change", () => {
        setCardSize(cardSizeSelect.value);
      });
    }

    if (els.closeCardPreviewButton) {
      els.closeCardPreviewButton.addEventListener("click", closeCardPreview);
    }

    if (els.rulesButton) {
      els.rulesButton.addEventListener("click", openRulesModal);
    }

    if (els.closeRulesButton) {
      els.closeRulesButton.addEventListener("click", closeRulesModal);
    }

    if (els.toggleAIPauseButton) {
      els.toggleAIPauseButton.addEventListener("click", toggleAIPause);
    }

    if (els.aiStepButton) {
      els.aiStepButton.addEventListener("click", () => {
        if (!gameState || !currentPlayer()?.isAI) return;
        if (aiPaused) {
          aiPaused = false;
          runAITurn(getAITurnKey(), { singleStep: true });
        }
      });
    }

    if (els.aiSpeedSelect) {
      els.aiSpeedSelect.addEventListener("change", () => {
        localStorage.setItem("pokemonSplendorAISpeed", els.aiSpeedSelect.value);
      });
    }

    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-preview]")) {
        closeCardPreview();
      }
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-rules]")) {
        closeRulesModal();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (els.cardPreviewModal && !els.cardPreviewModal.classList.contains("hidden")) {
          closeCardPreview();
        } else if (els.rulesModal && !els.rulesModal.classList.contains("hidden")) {
          closeRulesModal();
        }
      }
    });

    els.finalScreen.addEventListener("click", (event) => {
      if (event.target.closest("#finalRestartButton")) {
        if (gameState && !window.confirm("确认重新开始游戏？")) return;
        clearAISchedule();
        clearSavedGame();
        gameState = null;
        historyStack = [];
        notify("游戏已重新开始。", "info");
        render();
      }
      if (event.target.closest("#finalCloseButton")) {
        els.finalScreen.classList.add("hidden");
      }
    });

    document.addEventListener("dblclick", (event) => {
      const card = event.target.closest("[data-card-id]");
      if (card && gameState && gameState.phase !== "gameOver") {
        const cardId = card.dataset.cardId;
        openCardPreview(cardId);
      }
    });

    // v0.9.0 联机模式事件绑定
    bindOnlineEvents();

    bindDebugTools();
  }

  // =============================
  // v0.9.0 联机模式 UI 事件
  // =============================
  function bindOnlineEvents() {
    if (els.modeLocalBtn) {
      els.modeLocalBtn.addEventListener("click", () => {
        els.modeLocalBtn.classList.add("active");
        els.modeOnlineBtn.classList.remove("active");
        if (els.localPanel) els.localPanel.classList.remove("hidden");
        if (els.onlinePanel) els.onlinePanel.classList.add("hidden");
        if (els.onlineLobby) els.onlineLobby.classList.add("hidden");
      });
    }

    if (els.modeOnlineBtn) {
      els.modeOnlineBtn.addEventListener("click", () => {
        els.modeOnlineBtn.classList.add("active");
        els.modeLocalBtn.classList.remove("active");
        if (els.onlinePanel) els.onlinePanel.classList.remove("hidden");
        if (els.localPanel) els.localPanel.classList.add("hidden");
      });
    }

    if (els.onlinePlayerCount) {
      els.onlinePlayerCount.addEventListener("change", () => {
        const maxAI = Number(els.onlinePlayerCount.value);
        if (els.onlineAICount) {
          Array.from(els.onlineAICount.options).forEach((opt) => {
            opt.disabled = Number(opt.value) >= maxAI;
          });
          if (Number(els.onlineAICount.value) >= maxAI) {
            els.onlineAICount.value = String(maxAI - 1);
          }
        }
      });
    }

    if (els.createRoomButton) {
      els.createRoomButton.addEventListener("click", async () => {
        const name = (els.onlineCreateName?.value || "").trim() || "玩家 1";
        const pc = Number(els.onlinePlayerCount?.value || 2);
        const ac = Number(els.onlineAICount?.value || 0);
        try {
          if (!window.__pokemonOnline) { notify("联机模块未加载", "error"); return; }
          window.__pokemonOnline.connect();
          const res = await window.__pokemonOnline.createRoom(name, pc, ac);
          // v0.9.11: playerToken + roomCode 已在 online.js _applyOnlineResult 中保存
          // onRoomCreated callback 会统一调用 applyOnlineResumeResult 进入 LOBBY
        } catch (e) {
          notify(`创建房间失败：${e.message}`, "error");
        }
      });
    }

    if (els.joinRoomButton) {
      els.joinRoomButton.addEventListener("click", async () => {
        const name = (els.onlineJoinName?.value || "").trim() || "玩家";
        const code = normalizeRoomCode(els.onlineRoomCode?.value || "");
        if (!code) { notify("请输入房间号", "warn"); return; }
        if (els.onlineRoomCode) els.onlineRoomCode.value = code;
        try {
          if (!window.__pokemonOnline) { notify("联机模块未加载", "error"); return; }
          window.__pokemonOnline.connect();
          const res = await window.__pokemonOnline.joinRoom(code, name);
          // onRoomJoined callback → applyOnlineResumeResult → LOBBY
        } catch (e) {
          notify(`加入房间失败：${e.message}`, "error");
        }
      });
    }

    if (els.startOnlineGameButton) {
      els.startOnlineGameButton.addEventListener("click", async () => {
        try {
          const roomCode = onlineRoomCode || (els.lobbyRoomCode?.textContent || "");
          if (!window.__pokemonOnline) return;
          await window.__pokemonOnline.startOnlineGame(roomCode);
          // 服务器广播 stateUpdated 后客户端 setOnlineState + render
          // 这里再主动把界面切到 game（避免首次进入游戏界面显示问题）
          if (els.startScreen) els.startScreen.classList.add("hidden");
          if (els.onlineLobby) els.onlineLobby.classList.add("hidden");
          if (els.onlinePanel) els.onlinePanel.classList.add("hidden");
          if (els.gameScreen) els.gameScreen.classList.remove("hidden");
          render();
        } catch (e) {
          notify(`开始游戏失败：${e.message}`, "error");
        }
      });
    }

    if (els.leaveRoomButton) {
      els.leaveRoomButton.addEventListener("click", async () => {
        try {
          if (window.__pokemonOnline) await window.__pokemonOnline.leaveRoom();
          else {
            clearOnlineMode();
            clearOnlineSession();
          }
        } catch (e) { /* noop */ }
        if (els.gameScreen) els.gameScreen.classList.add("hidden");
        if (els.onlineLobby) els.onlineLobby.classList.add("hidden");
        if (els.onlinePanel) els.onlinePanel.classList.remove("hidden");
        if (els.modeLocalBtn && els.modeOnlineBtn) {
          // 保持联机模式，但显示 create/join 表单
        }
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("room");
          window.history.replaceState({}, "", url.toString());
        } catch (e) { /* noop */ }
        notify("已离开房间。", "info");
      });
    }

    // v0.9.2 复制房间号 / 复制加入链接
    if (els.lobbyCopyRoomCodeButton) {
      els.lobbyCopyRoomCodeButton.addEventListener("click", () => {
        const code = normalizeRoomCode(els.lobbyRoomCode?.textContent || "");
        copyToClipboard(code, "房间号已复制");
      });
    }
    if (els.lobbyCopyJoinLinkButton) {
      els.lobbyCopyJoinLinkButton.addEventListener("click", () => {
        const code = normalizeRoomCode(els.lobbyRoomCode?.textContent || "");
        copyToClipboard(buildJoinLink(code), "加入链接已复制");
      });
    }

    // v0.9.2 如何联机？弹窗
    if (els.howToConnectButton) {
      els.howToConnectButton.addEventListener("click", showHowToConnectModal);
    }
    if (els.closeHowToConnectButton) {
      els.closeHowToConnectButton.addEventListener("click", hideHowToConnectModal);
    }
    if (els.howToConnectModal) {
      els.howToConnectModal.addEventListener("click", (event) => {
        if (event.target === els.howToConnectModal || event.target.dataset.closeHowTo === "true") {
          hideHowToConnectModal();
        }
      });
    }
    // v0.9.11: 联机回调（onResumed / onResumeFailed / onRoomCreated / onRoomJoined 等）
    // 已在 boot() 中统一通过 __pokemonOnline.setCallbacks 注册；此处不再重复注册，避免覆盖统一 applyOnlineResumeResult 逻辑
  }

  function getAPISeatIndex() {
    return onlineSeatIndex;
  }

  function showOnlineLobby(roomCode, room, seatIndex) {
    if (els.onlinePanel) els.onlinePanel.classList.add("hidden");
    if (els.onlineLobby) els.onlineLobby.classList.remove("hidden");
    if (els.lobbyRoomCode) els.lobbyRoomCode.textContent = roomCode;
    const isHost = room && room.hostSeatIndex === seatIndex;
    renderLobbyPlayers(room, isHost, seatIndex);
    // v0.9.2 显示加入地址 + 加入链接
    updateLobbyJoinAddress(roomCode);
    if (els.lobbyStatus) {
      els.lobbyStatus.textContent = isHost ? "你是房主，等待其他玩家加入后点击开始游戏。" : "等待房主开始游戏...";
    }
  }

  // v0.9.2 拉取服务器局域网 IP，更新大厅加入地址显示
  // v0.9.3 公网部署：当访问来源为公网域名（Render onrender.com 等），
  //   直接显示 window.location.origin，不发起 /api/lan-info 请求，不提示同 WiFi。
  function updateLobbyJoinAddress(roomCode) {
    if (!els.lobbyJoinAddress) return;
    const code = normalizeRoomCode(roomCode);
    const isPrivate = isPrivateNetworkOrigin();
    let origin = "";
    try {
      if (typeof window !== "undefined" && window.location && window.location.origin) {
        origin = window.location.origin;
      }
    } catch (e) { /* noop */ }
    const hasOrigin = origin && origin !== "null" && !origin.startsWith("file:");
    if (!isPrivate) {
      // ---- v0.9.3 公网模式（Render 公网 / 其他云域名）----
      const baseAddr = hasOrigin ? origin : "—";
      els.lobbyJoinAddress.innerHTML = `<span class="public-badge">公网联机模式</span> 加入地址：${escapeHtml(baseAddr)}`;
      const link = hasOrigin ? `${origin}${window.location.pathname || "/"}?room=${encodeURIComponent(code)}` : "";
      if (els.lobbyLanHint) {
        if (link) {
          els.lobbyLanHint.textContent = "加入链接：" + link + "  朋友打开链接即可加入房间。";
        } else {
          els.lobbyLanHint.textContent = "复制加入链接后发给朋友，对方打开即可加入房间。";
        }
      }
      return;
    }
    // ---- 本地/局域网模式（原有逻辑）----
    if (hasOrigin) {
      els.lobbyJoinAddress.textContent = `加入地址：${origin}`;
    } else {
      els.lobbyJoinAddress.textContent = "加入地址：请在命令行输入 ipconfig 查看 IPv4 地址。";
    }
    if (els.lobbyLanHint) {
      els.lobbyLanHint.textContent = "请确保房主电脑与朋友设备处于同一 WiFi 网络。";
    }
    // 异步查询服务器局域网 IP，给出更精确的地址
    if (typeof fetch === "function" && fetch.toString().indexOf("no fetch") < 0) {
      fetch("/api/lan-info")
        .then((r) => r.json())
        .then((data) => {
          const addrs = (data && data.addresses) || [];
          if (addrs.length > 0 && data.port) {
            const addr = addrs[0].address;
            els.lobbyJoinAddress.textContent = `加入地址：http://${addr}:${data.port}`;
            if (els.lobbyLanHint) {
              const primary = `请确保双方处于同一 WiFi。加入链接：http://${addr}:${data.port}?room=${encodeURIComponent(code)}`;
              const other = addrs.length > 1
                ? `  其他可用地址：${addrs.slice(1).map((a) => `http://${a.address}:${data.port}`).join("、")}`
                : "";
              els.lobbyLanHint.textContent = primary + other;
            }
          } else if (els.lobbyLanHint) {
            els.lobbyLanHint.textContent = (data?.hint || "请在命令行输入 ipconfig 查看 IPv4 地址。") + "（双方需同一 WiFi）";
          }
        })
        .catch(() => {
          if (els.lobbyLanHint) els.lobbyLanHint.textContent = "无法自动识别局域网 IP，请在命令行输入 ipconfig 查看 IPv4 地址（双方需同一 WiFi）。";
        });
    }
  }

  // v0.9.2 渲染大厅玩家列表（含房主/已连接/断线/AI/等待中状态）
  function renderLobbyPlayers(room, isHost, localSeatIndex) {
    if (!els.lobbyPlayerList || !room) return;
    const players = room.players || [];
    const hostSeat = Number.isInteger(room.hostSeatIndex) ? room.hostSeatIndex : -1;
    let html = "";
    players.forEach((p, i) => {
      let status, cls, badges = "";
      if (p.isAI) {
        status = "AI";
        cls = "lobby-player ai";
      } else if (!p.name && !p.connected) {
        status = "等待中";
        cls = "lobby-player waiting";
      } else if (!p.connected) {
        status = "断线，可同名重连";
        cls = "lobby-player disconnected";
      } else {
        status = "已连接";
        cls = "lobby-player joined";
      }
      const isHostSeat = i === hostSeat;
      const isLocal = Number.isInteger(localSeatIndex) && i === localSeatIndex;
      if (isHostSeat) badges += `<span class="seat-tag host">房主</span>`;
      if (isLocal) badges += `<span class="seat-tag me">你</span>`;
      const nameText = p.name ? escapeHtml(p.name) : "等待中";
      html += `<div class="${cls}">
        <span class="seat-num">${i + 1}</span>
        <span class="seat-info"><span class="seat-name">${nameText}</span>${badges}</span>
        <span class="seat-status">${status}</span>
      </div>`;
    });
    els.lobbyPlayerList.innerHTML = html;

    if (els.startOnlineGameButton) {
      els.startOnlineGameButton.classList.toggle("hidden", !isHost);
    }
  }

  // v0.9.2 复制到剪贴板（兼容老浏览器）
  function copyToClipboard(text, successMsg) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => { if (successMsg) notify(successMsg, "info"); })
        .catch(() => fallbackCopy(text, successMsg));
    } else {
      fallbackCopy(text, successMsg);
    }
  }
  function fallbackCopy(text, successMsg) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (successMsg) notify(ok ? successMsg : "复制失败，请手动复制。", ok ? "info" : "warn");
    } catch (e) {
      if (successMsg) notify("复制失败，请手动复制。", "warn");
    }
  }

  // v0.9.2 如何联机？弹窗
  function showHowToConnectModal() {
    if (els.howToConnectModal) els.howToConnectModal.classList.remove("hidden");
  }
  function hideHowToConnectModal() {
    if (els.howToConnectModal) els.howToConnectModal.classList.add("hidden");
  }

  // v0.9.2 解析 URL ?room=房间号：切换到联机模式、填入房间号、光标定位到名称输入框
  // v0.9.11: 联机会话本地持久化（roomCode + playerToken；刷新后走 resumeRoom 权威恢复）
  const ONLINE_SESSION_KEY = "pokemonSplendorOnlineSession.v1";

  function saveOnlineSession({ roomCode, playerToken, playerName }) {
    if (!roomCode || !playerToken) return;
    try {
      const prev = JSON.parse(localStorage.getItem(ONLINE_SESSION_KEY) || "null");
      localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify({
        roomCode: String(roomCode).toUpperCase(),
        playerToken: String(playerToken),
        playerName: playerName || (prev && prev.playerName) || "",
        savedAt: Date.now()
      }));
    } catch (e) { /* noop */ }
  }

  function loadOnlineSession() {
    try {
      const raw = localStorage.getItem(ONLINE_SESSION_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      // v0.9.11: 必须同时存在 roomCode + playerToken 才视为有效会话（playerName 仅作 UI 显示）
      if (!d || !d.roomCode || !d.playerToken) return null;
      if (d.savedAt && Date.now() - d.savedAt > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(ONLINE_SESSION_KEY);
        return null;
      }
      return d;
    } catch (e) { return null; }
  }

  function clearOnlineSession() {
    try { localStorage.removeItem(ONLINE_SESSION_KEY); } catch (e) { /* noop */ }
  }

  // v0.9.9: 创建/加入房间后，把 ?room= 写入 URL（不创建新历史条目，避免影响后退键）
  // 这样房主刷新也能触发 silentRejoinRoom（房主创建房间时 URL 原本是干净的）
  function updateRoomUrl(roomCode) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("room", roomCode);
      window.history.replaceState({}, "", url.toString());
    } catch (e) { /* noop */ }
  }

  // v0.9.11: 刷新/重连后统一 applyOnlineResumeResult(res) 决策 LOBBY / GAME
  //   res: {ok:true, roomCode, seatIndex, isHost, playerToken, playerName, room, gameStarted, gameState}
  // 原则：gameStarted=true 或 gameState 有效 → 进入 GAME；否则进入 LOBBY。禁止被其他 callback 二次覆盖。
  // 注意：setOnlineMode + setOnlineState 在 online.js 的 _applyOnlineResult 中已经执行；此处仅负责 UI 路由（LOBBY vs GAME）。
  function applyOnlineResumeResult(res) {
    if (!res || !res.ok) return;
    const roomCode = res.roomCode;
    const seatIndex = res.seatIndex;
    updateRoomUrl(roomCode);
    const isGame = res.gameStarted === true || !!res.gameState;
    if (isGame) {
      // v0.9.11: 游戏中 → 直接切换到游戏画面，绝对禁止再调 showOnlineLobby
      if (els.onlinePanel) els.onlinePanel.classList.add("hidden");
      if (els.onlineLobby) els.onlineLobby.classList.add("hidden");
      if (els.startScreen) els.startScreen.classList.add("hidden");
      if (els.gameScreen) els.gameScreen.classList.remove("hidden");
      // 如果服务器携带 gameState，确保渲染（online.js _applyOnlineResult 已调用 setOnlineState，这里再 render 一次防遗漏）
      if (res.gameState) {
        try {
          gameState = hydrateGameState(res.gameState);
          historyStack = [];
          pendingTokenSelection = [];
        } catch (e) { /* noop */ }
      }
      render();
      updateLandscapeHint();
    } else {
      // waiting 状态 → 进入 Lobby（但不再回 create/join 初始界面）
      showOnlineLobby(roomCode, res.room || sanitizeLobbyFromSeat(seatIndex), seatIndex);
    }
  }

  function sanitizeLobbyFromSeat(seatIndex) {
    // 兜底：room 缺失时，基于 onlineSeatIndex 和 onlineRoomCode 输出最小结构
    return {
      roomCode: onlineRoomCode,
      players: (Array(Number(onlineMode ? onlineState : 2)).fill(null).map((_,i)=>({
        name: i===seatIndex ? (gameState?.players?.[i]?.name || "") : "",
        connected: i===seatIndex,
        seatIndex: i,
        isAI: false
      }))),
      hostSeatIndex: onlineIsHost === true ? seatIndex : 0
    };
  }

  // v0.9.11: resume 失败（ROOM_NOT_FOUND / INVALID_PLAYER_TOKEN）→ 清理 session + 回初始联机界面
  function handleResumeFailed(code, message) {
    clearOnlineSession();
    // 清 online 状态（避免残留旧 roomCode 误导）
    if (typeof clearOnlineMode === "function") clearOnlineMode();
    // 回初始界面：显示 create/join 面板，隐藏 lobby 和 game
    if (els.gameScreen) els.gameScreen.classList.add("hidden");
    if (els.onlineLobby) els.onlineLobby.classList.add("hidden");
    if (els.onlinePanel) els.onlinePanel.classList.remove("hidden");
    if (els.modeOnlineBtn && els.modeLocalBtn) {
      // 保持在联机模式 tab（用户是联机意图才会失败到这）
    }
    if (code === "ROOM_NOT_FOUND") {
      notify("房间已不存在（服务器重启或房间过期），已自动清理本地会话。", "warn");
    } else if (code === "INVALID_PLAYER_TOKEN") {
      notify("本地凭证已失效，请重新创建/加入房间。", "warn");
    } else {
      notify("恢复房间失败：" + (message || code || "未知错误"), "warn");
    }
  }

  // v0.9.11: 取消旧的 silentRejoinRoom（走 playerName），统一改为 resumeRoom + applyOnlineResumeResult
  async function silentRejoinRoom(roomCode, playerName) {
    // 仅保留函数名兼容旧代码调用；实际恢复统一走 __pokemonOnline.resumeRoom
    try {
      if (!window.__pokemonOnline) return;
      window.__pokemonOnline.connect();
      // 本地如果已经有 session（roomCode + playerToken），直接 resume；否则没法恢复
      const sess = loadOnlineSession();
      if (!sess || sess.roomCode !== String(roomCode || "").toUpperCase()) {
        // 没有 token，无法恢复
        throw new Error("缺少 playerToken，无法自动恢复房间。请重新输入玩家名加入。");
      }
      const res = await window.__pokemonOnline.resumeRoom(sess.roomCode, sess.playerToken);
      // applyOnlineResumeResult 由 onResumed callback 统一调用，不需要在此重复
    } catch (e) {
      notify("自动重连失败：" + e.message + "。请重新输入玩家名加入。", "warn");
      if (els.onlineJoinName) { try { els.onlineJoinName.focus(); } catch (e2) { /* noop */ } }
    }
  }

  function applyRoomCodeFromUrl() {
    if (typeof window === "undefined" || !window.location) return null;
    let code = null;
    try {
      const params = new URLSearchParams(window.location.search);
      code = params.get("room");
    } catch (e) { return null; }
    if (!code) return null;
    code = normalizeRoomCode(code);
    if (!code) return null;
    // 切换到联机模式
    if (els.modeOnlineBtn && els.modeLocalBtn) {
      els.modeOnlineBtn.classList.add("active");
      els.modeLocalBtn.classList.remove("active");
      if (els.onlinePanel) els.onlinePanel.classList.remove("hidden");
      if (els.localPanel) els.localPanel.classList.add("hidden");
    }
    // 填入房间号
    if (els.onlineRoomCode) els.onlineRoomCode.value = code;
    // v0.9.9: 静默自动重连 — URL ?room= 与本地保存的会话房间号匹配时，自动尝试加入
    const savedSession = loadOnlineSession();
    if (savedSession && savedSession.playerName && savedSession.roomCode === code) {
      // 预填玩家名（即便重连失败，用户也能直接点按钮重试）
      if (els.onlineJoinName) els.onlineJoinName.value = savedSession.playerName;
      silentRejoinRoom(code, savedSession.playerName);
      return code;
    }
    // 无保存会话或房间号不匹配 → 退回旧行为：聚焦玩家名输入框等用户输入
    if (els.onlineJoinName) {
      try { els.onlineJoinName.focus(); } catch (e) { /* noop */ }
    }
    return code;
  }

  function bindDebugTools() {
    els.debugAddToTableau.addEventListener("click", () => {
      if (!gameState) return;
      const cardId = els.debugCardSelect.value;
      const card = cardDatabase.find((c) => c.id === cardId);
      if (!card) return;
      const player = currentPlayer();
      if (!player) return;
      player.tableau.push(clone(card));
      updatePlayerScore(player);
      saveGame();
      render();
    });

    els.debugAddToReserved.addEventListener("click", () => {
      if (!gameState) return;
      const player = currentPlayer();
      if (!player || player.reserved.length >= 3) return;
      const cardId = els.debugCardSelect.value;
      const card = cardDatabase.find((c) => c.id === cardId);
      if (!card) return;
      player.reserved.push(clone(card));
      updatePlayerScore(player);
      saveGame();
      render();
    });

    const tokenColors = [
      { el: els.debugTokenRed, color: "red" },
      { el: els.debugTokenBlue, color: "blue" },
      { el: els.debugTokenBlack, color: "black" },
      { el: els.debugTokenPink, color: "pink" },
      { el: els.debugTokenYellow, color: "yellow" },
      { el: els.debugTokenPurple, color: "purple" }
    ];

    tokenColors.forEach(({ el, color }) => {
      el.addEventListener("click", () => {
        if (!gameState) return;
        const player = currentPlayer();
        if (!player) return;
        player.tokens[color] += 1;
        updatePlayerScore(player);
        saveGame();
        render();
      });
    });

    els.debugClearTokens.addEventListener("click", () => {
      if (!gameState) return;
      const player = currentPlayer();
      if (!player) return;
      player.tokens = emptyTokens();
      updatePlayerScore(player);
      saveGame();
      render();
    });

    els.debugAddManyTokens.addEventListener("click", () => {
      if (!gameState) return;
      const player = currentPlayer();
      if (!player) return;
      NORMAL_COLORS.forEach((color) => { player.tokens[color] += 10; });
      player.tokens.purple += 5;
      updatePlayerScore(player);
      saveGame();
      render();
    });

    els.debugRefreshScore.addEventListener("click", () => {
      if (!gameState) return;
      gameState.players.forEach(updatePlayerScore);
      saveGame();
      render();
    });

    els.debugClearPlayerCards.addEventListener("click", () => {
      if (!gameState) return;
      const player = currentPlayer();
      if (!player) return;
      player.tableau = [];
      player.reserved = [];
      player.evolvedArchive = [];
      updatePlayerScore(player);
      saveGame();
      render();
    });

    els.debugForceEvolve.addEventListener("click", () => {
      if (!gameState) return;
      gameState.mainActionDone = true;
      gameState.phase = "evolve";
      gameState.selectedCard = null;
      saveGame();
      render();
    });

    els.debugForceEndTurn.addEventListener("click", () => {
      if (!gameState) return;
      const player = currentPlayer();
      if (!player) return;
      updatePlayerScore(player);
      gameState.playerTurns[gameState.currentPlayerIndex] += 1;
      gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.playerCount;
      if (gameState.currentPlayerIndex === 0) gameState.turnNumber += 1;
      gameState.phase = "awaitAction";
      gameState.mainActionDone = false;
      gameState.didEvolveThisTurn = false;
      gameState.selectedCard = null;
      saveGame();
      render();
    });

    els.debugClearStorage.addEventListener("click", () => {
      clearSavedGame();
      location.reload();
    });

    const debugClearCardCache = document.getElementById("debugClearCardCache");
    if (debugClearCardCache) {
      debugClearCardCache.addEventListener("click", () => {
        localStorage.removeItem(CARD_CACHE_KEY);
        notify("已清除卡牌缓存，请刷新后重新导入 cards.json。", "info");
      });
    }
  }

  function maybeShowFirstTimeTip() {
    const key = "pokemonSplendorRulesTipSeen";
    if (localStorage.getItem(key)) return;

    notify('第一次游玩建议先点击右上角"规则说明"。', "info");
    localStorage.setItem(key, "1");
  }

  async function boot() {
    cacheElements();
    bindEvents();
    notify("正在读取卡牌数据...", "info");
    // v0.9.11: 只要存在 roomCode + playerToken 会话，就视为联机刷新恢复，跳过单机存档加载
    // （如果 resume 最终失败，handleResumeFailed 会清 session，用户可以手动开始单机或重新联机）
    let skipLocalSave = false;
    const savedSession = loadOnlineSession();
    if (savedSession) skipLocalSave = true;
    const saved = skipLocalSave ? null : loadSavedGame();
    try {
      await loadCardDataAutomatically();
      if (saved) {
        gameState = saved;
        notify("已恢复本地存档。", "info");
      } else {
        notify(`已读取 ${cardDatabase.length} 张卡牌，可以开始游戏。`, "info");
      }
    } catch (error) {
      if (saved) {
        gameState = saved;
        notify("已恢复本地存档。如需新游戏请选择 cards.json。", "warn");
      } else {
        notify("卡牌数据自动读取失败，请选择 cards.json 文件。", "warn");
      }
    }
    render();
    maybeShowFirstTimeTip();
    updateLandscapeHint();
    // v0.9.11: 先注册 onResumed callback，再 applyRoomCodeFromUrl / resume
    // 保证 applyOnlineResumeResult 在 resume 返回前已准备好
    (function setupOnlineOnce(){
      if (!window.__pokemonOnline || window.__pokemonOnline._v0911CallbacksInstalled) return;
      try {
        const oldCb = window.__pokemonOnline.getCallbacks ? window.__pokemonOnline.getCallbacks() : null;
        window.__pokemonOnline.setCallbacks({
          onResumed: (res) => applyOnlineResumeResult(res),
          onResumeFailed: (code, message) => handleResumeFailed(code, message),
          onRoomCreated: (res) => applyOnlineResumeResult(res),  // createRoom 成功也走统一路由
          onRoomJoined: (res) => applyOnlineResumeResult(res),   // joinRoom 成功也走统一路由
          onRoomUpdated: (data) => {
            const roomCode = onlineRoomCode || (els.lobbyRoomCode?.textContent || "");
            if (roomCode && data && data.room) {
              const seat = getAPISeatIndex();
              const isHost = onlineIsHost === true || (data.room.hostSeatIndex === seat);
              // 只有在 lobby 可见时更新列表；游戏进行中 roomUpdated 广播不切界面
              if (els.onlineLobby && !els.onlineLobby.classList.contains("hidden")) {
                renderLobbyPlayers(data.room, isHost, seat);
              }
            }
          },
          onActionRejected: (data) => { if (data?.message) notify(data.message, "warn"); },
          onPlayerDisconnected: (data) => { if (data?.name) notify(`${data.name} 掉线了。`, "warn"); },
          onPlayerReconnected: (data) => { if (data?.name) notify(`${data.name} 重新连接。`, "info"); },
          onConnectionError: () => {
            notify("无法连接服务器，请确认服务器已运行 npm start。", "error");
          }
        });
        window.__pokemonOnline._v0911CallbacksInstalled = true;
      } catch (e) { /* noop */ }
    })();
    // v0.9.11: 有本地 session → 直接 resume（同时也会走 applyRoomCodeFromUrl 处理 URL ?room= 用于 UI 预填）
    if (savedSession) {
      try {
        if (!window.__pokemonOnline) throw new Error("联机模块未加载");
        window.__pokemonOnline.connect();
        // v0.9.11: 用本地 playerToken 做权威 resume；applyOnlineResumeResult 由 callback 统一触发
        window.__pokemonOnline.resumeRoom(savedSession.roomCode, savedSession.playerToken);
      } catch (e) {
        notify("自动恢复房间失败：" + e.message, "warn");
      }
    }
    // URL ?room= 同步（即便已在恢复，也需切联机 tab、填房间号）
    try { applyRoomCodeFromUrl(); } catch (e) { /* noop */ }
    try {
      window.addEventListener("resize", updateLandscapeHint);
      window.addEventListener("orientationchange", updateLandscapeHint);
    } catch (e) { /* noop */ }
  }
  window.calculateDiscount = calculateDiscount;
  window.calculatePayCost = calculatePayCost;
  window.canBuy = canBuy;
  window.buyCard = buyCard;
  window.getEvolveOptions = getEvolveOptions;
  window.canEvolve = canEvolve;
  window.evolvePokemon = evolvePokemon;

  // =============================
  // v0.9.0 联机模式辅助函数
  // =============================
  function isOnlineLocalTurn() {
    if (!onlineMode || !gameState) return false;
    return gameState.currentPlayerIndex === onlineSeatIndex;
  }

  function submitOnlineAction(action) {
    if (!onlineMode || !onlineSocket) {
      notify("联机未连接，无法发送行动。", "error");
      return;
    }
    // v0.9.11: 绝不发送 seatIndex/playerIndex（服务端根据 socket.id → socketToMember 反向映射权威获取身份）
    onlineSocket.emit("playerAction", {
      roomCode: onlineRoomCode,
      action
    });
  }

  function setOnlineState(state) {
    gameState = hydrateGameState(state);
    historyStack = [];
    pendingTokenSelection = [];
    render();
    updateLandscapeHint();
  }

  function setOnlineMode(params) {
    onlineMode = true;
    onlineSocket = params.socket;
    onlineRoomCode = params.roomCode;
    onlineSeatIndex = Number.isInteger(params.seatIndex) ? params.seatIndex : null;
    onlineIsHost = Boolean(params.isHost);
    onlineSpectatorIndex = Number.isInteger(params.spectatorIndex) ? params.spectatorIndex : null;
    onlineConnected = true;
    document.body.classList.add("online-mode");
    if (els.roomBadge) {
      els.roomBadge.textContent = `${params.roomCode}`;
      els.roomBadge.classList.add("online");
    }
    updateLandscapeHint();
  }

  function clearOnlineMode() {
    onlineMode = false;
    onlineSocket = null;
    onlineRoomCode = "";
    onlineSeatIndex = null;
    onlineIsHost = false;
    onlineSpectatorIndex = null;
    onlineConnected = false;
    document.body.classList.remove("online-mode");
    if (els.roomBadge) {
      els.roomBadge.textContent = "单机模式";
      els.roomBadge.classList.remove("online");
    }
  }

  function setOnlineConnected(flag) {
    onlineConnected = Boolean(flag);
    if (gameState) render(); // 触发顶栏连接状态刷新
  }

  function updateLandscapeHint() {
    // 手机竖屏提示
    try {
      const w = window.innerWidth;
      const mobile = w < 700;
      document.body.classList.toggle("mobile-portrait", mobile && w < window.innerHeight);
    } catch (e) { /* noop */ }
  }

  function resetStateForTest() {
    clearAISchedule();
    gameState = null;
    clearSavedGame();
  }

  function getPlayerIndexForTest(player) {
    return resolvePlayerIndex(player);
  }

  window.__pokemonSplendorTestAPI = {
    loadCardDataAutomatically,
    startNewGame,
    startNewGameWithAI: (playerCount, aiCount) => {
      if (!cardDatabase.length) return;
      clearAISchedule();
      gameState = createEmptyGameState(playerCount);
      gameState.decks = buildDecks(cardDatabase);
      refillAllMarkets();
      for (let i = playerCount - aiCount; i < playerCount; i++) {
        gameState.players[i].isAI = true;
        gameState.players[i].name = `玩家 ${i + 1}（AI）`;
      }
      historyStack = [];
    },
    getState: () => gameState,
    getGameState: () => gameState,
    getCards: () => cardDatabase,
    setState: (state) => { gameState = state; },
    resetStateForTest,
    currentPlayer,
    takeThreeDifferentTokens,
    takeTwoSameTokens,
    reserveSelectedCard,
    blindReserve,
    buyCard,
    buySelectedCard,
    calculateDiscount,
    calculatePayCost,
    canBuy,
    getEvolveOptions,
    canEvolve,
    evolvePokemon,
    discardToken,
    skipEvolution,
    endTurn,
    setSelectedCard,
    drawToMarket,
    updatePlayerScore,
    saveGame,
    render,
    refillAllMarkets,
    getPayInfo,
    getSelectedCardRef,
    findBuyableCardRef,
    clearSavedGame,
    buildDecks,
    createEmptyGameState: (playerCount) => {
      gameState = createEmptyGameState(playerCount);
      if (cardDatabase.length) {
        gameState.decks = buildDecks(cardDatabase);
        refillAllMarkets();
      }
      return gameState;
    },
    hydrateGameState,
    createPlayer,
    normalizeCardList,
    normalizeCard,
    ALL_COLORS,
    NORMAL_COLORS,
    MARKET_KEYS,
    TOKEN_LABELS,
    notify,
    addActionLogForTest: addActionLog,
    totalTokens,
    sumPoints,
    clone,
    emptyTokens,
    normalizeTokens,
    aiTryBuyBestCard,
    aiTakeUsefulTokens,
    takeDifferentTokensForAI,
    getRequiredDifferentTokenCount,
    toggleAIPause,
    get aiPaused() { return aiPaused; },
    aiDiscard: (player) => {
      const playerIndex = getPlayerIndexForTest(player);
      if (playerIndex < 0) return;
      gameState.phase = "discard";
      gameState.currentPlayerIndex = playerIndex;
      while (totalTokens(player.tokens) > 10) {
        const normalColors = NORMAL_COLORS.filter((color) => (player.tokens[color] || 0) > 0);
        if (normalColors.length > 0) {
          const maxColor = normalColors.reduce((a, b) => (player.tokens[a] || 0) > (player.tokens[b] || 0) ? a : b);
          if (!performDiscardToken(playerIndex, maxColor)) break;
        } else if (player.tokens.purple > 0) {
          if (!performDiscardToken(playerIndex, "purple")) break;
        } else {
          break;
        }
      }
    },
    forceAIDiscard: (player) => {
      const playerIndex = getPlayerIndexForTest(player);
      if (playerIndex < 0) return;
      player.tokens.red = 5;
      player.tokens.blue = 3;
      player.tokens.black = 3;
      player.tokens.pink = 2;
      player.tokens.yellow = 2;
      player.tokens.purple = 1;
      gameState.phase = "discard";
      gameState.currentPlayerIndex = playerIndex;
      while (totalTokens(player.tokens) > 10) {
        const normalColors = NORMAL_COLORS.filter((color) => (player.tokens[color] || 0) > 0);
        if (normalColors.length > 0) {
          const maxColor = normalColors.reduce((a, b) => (player.tokens[a] || 0) > (player.tokens[b] || 0) ? a : b);
          if (!performDiscardToken(playerIndex, maxColor)) break;
        } else if (player.tokens.purple > 0) {
          if (!performDiscardToken(playerIndex, "purple")) break;
        } else {
          break;
        }
      }
    },
    finishGame,
    finishGameByStalemate,
    runCurrentAITurnForTest: async () => {
      if (!gameState) return;
      const previousPaused = aiPaused;
      aiPaused = true;
      const key = getAITurnKey();
      aiThinking = true;
      aiTurnKey = key;
      try {
        await runAITurn(key, { singleStep: true });
      } finally {
        aiPaused = previousPaused;
        clearAISchedule();
      }
    },
    aiHasAnyLegalMainAction,
    aiFallbackLegalAction,
    getGameStage,
    evaluateCardForAI,
    chooseAITargetCard,
    getMCTSRuntimeConfig,
    MAX_AUTO_TURNS,
    scoreActionForHeuristic,
    evaluateState,
    chooseActionByMCTS,
    canEvolveInState,
    evaluateCardForAIInState,
    chooseAITargetCardInState,
    getCardName,
    generateLegalActions: (playerIndex, state) => generateLegalActions(playerIndex, state),
    applyActionToState: (state, playerIndex, action) => applyActionToState(state, playerIndex, action),
    // v0.9.0 联机纯逻辑
    applyOnlineActionToState: (state, playerIndex, action) => applyOnlineActionToState(state, playerIndex, action),
    applyMainActionToState: (state, playerIndex, action) => applyMainActionToState(state, playerIndex, action),
    getOnlineMode: () => onlineMode,
    getOnlineRoomCode: () => onlineRoomCode,
    getOnlineSeatIndex: () => onlineSeatIndex,
    getOnlineIsHost: () => onlineIsHost,
    getOnlineSpectatorIndex: () => onlineSpectatorIndex,
    getOnlineConnected: () => onlineConnected,
    setOnlineMode,
    clearOnlineMode,
    setOnlineState,
    setOnlineConnected,
    isOnlineLocalTurn,
    submitOnlineAction: (action) => submitOnlineAction(action),
    localPlayer: () => localPlayer(),
    currentPlayer: () => currentPlayer(),
    onlineIdentityText: () => onlineIdentityText(),
    onlineConnectText: () => onlineConnectText(),
    // 测试用：设置 onlineMode 而不真正连接 socket
    setOnlineModeForTest: (mode) => { onlineMode = Boolean(mode); },
    setOnlineSeatIndexForTest: (idx) => { onlineSeatIndex = idx; },
    updateLandscapeHint,
    // v0.9.2 联机入口体验辅助
    normalizeRoomCode,
    buildJoinLink,
    findReconnectSeat,
    findEmptySeat,
    applyRoomCodeFromUrl,
    // v0.9.3 公网部署辅助
    isPrivateNetworkOrigin,
    // v0.9.4 图片性能优化
    getCardThumbnailPath,
    getTokenThumbnailPath,
    buildImgTagWithFallback
  };

  document.addEventListener("DOMContentLoaded", boot);

  // =============================
  // Node.js 模块导出（服务器复用纯逻辑）
  // =============================
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createEmptyGameState,
      createPlayer,
      hydrateGameState,
      normalizeCard,
      normalizeTokens,
      normalizeCardList,
      buildDecks,
      refillAllMarkets,
      refillMarketInState,
      generateLegalActions,
      applyActionToState,
      applyOnlineActionToState,
      applyMainActionToState,
      applyManualEvolveToState,
      finishOnlineTurn,
      findMatchingLegalAction,
      calculateDiscount,
      calculateDiscountInState,
      calculatePayCost,
      calculatePayCostInState,
      canBuy,
      canBuyInState,
      canEvolve,
      canEvolveInState,
      getEvolveOptions,
      getEvolveOptionsInState,
      clone,
      totalTokens,
      sumPoints,
      updatePlayerScore,
      updatePlayerScoreInState,
      rankPlayersInState,
      advanceTurnInState,
      discardDownToLimitInState,
      applyBestEvolutionInState,
      getCardName,
      getMCTSRuntimeConfig,
      chooseActionByMCTS,
      evaluateState,
      scoreActionForHeuristic,
      evaluateCardForAIInState,
      chooseAITargetCardInState,
      getGameStage,
      NORMAL_COLORS,
      ALL_COLORS,
      MARKET_KEYS,
      INITIAL_SUPPLY,
      TOKEN_LABELS,
      MARKET_LABELS,
      // v0.9.2 联机辅助（服务器/测试复用）
      normalizeRoomCode,
      findReconnectSeat,
      findEmptySeat,
      // v0.9.3 公网部署辅助
      isPrivateNetworkOrigin,
      // v0.9.4 图片性能优化
      getCardThumbnailPath,
      getTokenThumbnailPath
    };
  }

  // =============================
  // v0.9.8: 鼠标悬停放大卡牌（浮层预览，不破坏现有布局）
  // 仅浏览器环境运行；click 仍触发 openCardPreview 模态，hover 仅作快速预览
  // =============================
  if (!__isNode) {
    let hoverPreviewEl = null;
    let hoverPreviewTimer = null;
    let hoverPreviewCurrentCard = null;

    function showCardHoverPreview(card, evt) {
      clearTimeout(hoverPreviewTimer);
      hoverPreviewCurrentCard = card;
      // 150ms 延迟，避免鼠标快速划过闪烁
      hoverPreviewTimer = setTimeout(function () {
        if (!hoverPreviewCurrentCard) return;
        const img = hoverPreviewCurrentCard.querySelector(".card-image");
        if (!img) return;
        const src = img.getAttribute("src") || "";
        if (!src || src.startsWith("data:")) return;
        if (!hoverPreviewEl) {
          hoverPreviewEl = document.createElement("div");
          hoverPreviewEl.className = "card-hover-preview";
          document.body.appendChild(hoverPreviewEl);
        }
        hoverPreviewEl.innerHTML = '<img src="' + src + '" alt="" loading="eager" decoding="sync">';
        moveCardHoverPreview(evt);
        hoverPreviewEl.style.display = "block";
      }, 150);
    }

    function moveCardHoverPreview(evt) {
      if (!hoverPreviewEl || hoverPreviewEl.style.display === "none") return;
      const w = hoverPreviewEl.offsetWidth || 280;
      const h = hoverPreviewEl.offsetHeight || 400;
      const margin = 16;
      let x = evt.clientX + 20;
      let y = evt.clientY + 20;
      if (x + w + margin > window.innerWidth) x = evt.clientX - w - 20;
      if (y + h + margin > window.innerHeight) y = evt.clientY - h - 20;
      if (x < 8) x = 8;
      if (y < 8) y = 8;
      hoverPreviewEl.style.left = x + "px";
      hoverPreviewEl.style.top = y + "px";
    }

    function hideCardHoverPreview() {
      clearTimeout(hoverPreviewTimer);
      hoverPreviewCurrentCard = null;
      if (hoverPreviewEl) hoverPreviewEl.style.display = "none";
    }

    function setupCardHoverPreview() {
      if (document.body.dataset.hoverPreviewBound) return;
      document.body.dataset.hoverPreviewBound = "1";
      document.body.addEventListener("mouseover", function (e) {
        const card = e.target.closest(".card");
        if (!card) return;
        showCardHoverPreview(card, e);
      });
      document.body.addEventListener("mouseout", function (e) {
        const card = e.target.closest(".card");
        if (!card) return;
        const related = e.relatedTarget;
        // 在 card 子元素间移动不算离开，避免闪烁
        if (related && card.contains(related)) return;
        hideCardHoverPreview();
      });
      document.body.addEventListener("mousemove", function (e) {
        if (!hoverPreviewEl || hoverPreviewEl.style.display === "none") return;
        moveCardHoverPreview(e);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") hideCardHoverPreview();
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", setupCardHoverPreview);
    } else {
      setupCardHoverPreview();
    }
  }
})();
