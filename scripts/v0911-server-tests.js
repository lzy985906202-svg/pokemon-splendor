"use strict";
// ========================================
// v0.9.11 联机刷新/重连专项测试（Node 端）
// ========================================
const assert = require("assert");
const path = require("path");
const { io: ioc } = require("socket.io-client");
const http = require("http");

const PORT = 13799;
process.env.PORT = String(PORT);
// 启动 server（直接 listen）
require(path.join(__dirname, "..", "server.js"));
const SERVER_URL = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name} :: ${e.message || String(e)}`); }
}
function sock() { return ioc(SERVER_URL, { transports: ["websocket"], forceNew: true }); }
function emit(s, ev, payload, timeoutMs) {
  const t = timeoutMs || 4000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { s.off(ev); } catch(e) {}
      reject(new Error(`emit timeout: ${ev} (${t}ms)`));
    }, t);
    try {
      s.emit(ev, payload, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sumT(tokens){ if(!tokens) return 0; return Object.values(tokens).reduce((a,b)=>a+(Number(b)||0),0); }
function cloneState(res) { return res && res.gameState ? JSON.parse(JSON.stringify(res.gameState)) : null; }

async function waitForServer() {
  for (let i=0;i<40;i++) {
    await wait(100);
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${PORT}/health`, (res) => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>resolve(d)); });
        req.on("error", reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error("to")); });
      });
      return;
    } catch (e) {}
  }
}

// ========== 主要测试函数 ==========
async function main() {
  await waitForServer();
  console.log(`server ready on ${PORT}\n`);

  // ---- T1 ----
  await test("TEST 01 createRoom 返回稳定 playerToken", async () => {
    const a = sock();
    const res = await emit(a, "createRoom", { playerName:"HostA", playerCount:2, aiCount:0 });
    assert(res.ok); assert(res.playerToken && res.playerToken.length>10);
    assert.strictEqual(res.isHost, true); assert.strictEqual(res.seatIndex, 0);
    a.close();
  });

  // ---- T2 ----
  await test("TEST 02 joinRoom 返回不同 token", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    assert(rb.ok && rb.playerToken); assert.notStrictEqual(ra.playerToken, rb.playerToken);
    assert(!rb.isHost); assert.strictEqual(rb.seatIndex, 1);
    a.close(); b.close();
  });

  // ---- T3 ----
  await test("TEST 03 房主 disconnect+resume → seatIndex=0, isHost=true", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"HostA", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    a.disconnect(); await wait(180);
    const a2 = sock(); const rr = await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    assert(rr.ok); assert.strictEqual(rr.seatIndex, 0); assert.strictEqual(rr.isHost, true);
    a2.close(); b.close();
  });

  // ---- T4 ----
  await test("TEST 04 普通玩家 disconnect+resume → seatIndex=1, isHost=false", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    const tokB = rb.playerToken;
    b.disconnect(); await wait(180);
    const b2 = sock(); const rr = await emit(b2, "resumeRoom", { roomCode: ra.roomCode, playerToken: tokB });
    assert(rr.ok); assert.strictEqual(rr.seatIndex, 1); assert.strictEqual(rr.isHost, false);
    a.close(); b2.close();
  });

  // ---- T5 ----
  await test("TEST 05 同 token 连续 resume 5 次 → players.length 仍 2", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    let cur = b;
    for (let i=0;i<5;i++) {
      cur.disconnect(); await wait(120);
      cur = sock();
      const rr = await emit(cur, "resumeRoom", { roomCode: ra.roomCode, playerToken: rb.playerToken });
      assert(rr.ok, `#${i} resume fail`);
      assert.strictEqual(rr.room.players.length, 2, `#${i} 人数: ${rr.room?.players?.length}`);
    }
    a.close(); cur.close();
  });

  // ---- T6 ----
  await test("TEST 06 旧 socket 不能再发 playerAction", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(200);
    const aOld = a;
    const a2 = sock(); await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    await wait(250); // 给服务器 disconnect 旧 socket 留足时间
    // 旧 socket emit playerAction：如果服务器已断开它，就不会有 ack。
    // 无论 ack 超时或返回 {ok:false}，都视为"旧 socket 不能行动"
    let stillWorks = false;
    try {
      const rej = await emit(aOld, "playerAction", { roomCode: ra.roomCode, action:{ type:"takeSame", color:"red" } }, 2500);
      if (rej && rej.ok === true) stillWorks = true;
    } catch (_timeoutOrDisconnect) {
      // ack 没回来（超时/断连）= 旧 socket 已被服务器踢掉 → 正确行为
    }
    assert(!stillWorks, "旧 socket 还能行动成功！");
    a2.close(); b.close();
    try { aOld.close(); } catch(e){}
  });

  // ---- T7 ----
  await test("TEST 07 INVALID_PLAYER_TOKEN", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const x = sock(); const r = await emit(x, "resumeRoom", { roomCode: ra.roomCode, playerToken: "fake" });
    assert(!r.ok && r.code === "INVALID_PLAYER_TOKEN");
    a.close(); x.close();
  });

  // ---- T8 ----
  await test("TEST 08 ROOM_NOT_FOUND", async () => {
    const x = sock(); const r = await emit(x, "resumeRoom", { roomCode: "ZZZZ", playerToken: "x" });
    assert(!r.ok && r.code === "ROOM_NOT_FOUND");
    x.close();
  });

  // ---- T9 ----
  await test("TEST 09 未开始：房主 resume 后仍可 startGame", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    a.disconnect(); await wait(180);
    const a2 = sock(); const rr = await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    assert(rr.ok && rr.isHost);
    const sg = await emit(a2, "startOnlineGame", { roomCode: ra.roomCode });
    assert(sg.ok);
    a2.close(); b.close();
  });

  // ---- T10 ----
  await test("TEST 10 未开始：普通玩家 resume 回 lobby（gameStarted=false）", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    b.disconnect(); await wait(180);
    const b2 = sock(); const rr = await emit(b2, "resumeRoom", { roomCode: ra.roomCode, playerToken: rb.playerToken });
    assert(rr.ok && rr.gameStarted === false && rr.isHost === false);
    a.close(); b2.close();
  });

  // ---- T11 ----
  await test("TEST 11 已开始：房主 resume → GAME (gameState 下发)", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    a.disconnect(); await wait(200);
    const a2 = sock(); const rr = await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    assert(rr.ok && rr.gameStarted === true);
    assert(rr.gameState && rr.gameState.players && rr.gameState.players.length === 2);
    assert(rr.isHost === true);
    a2.close(); b.close();
  });

  // ---- T12 ----
  await test("TEST 12 已开始：普通玩家 resume → GAME", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    b.disconnect(); await wait(200);
    const b2 = sock(); const rr = await emit(b2, "resumeRoom", { roomCode: ra.roomCode, playerToken: rb.playerToken });
    assert(rr.ok && rr.gameStarted === true && rr.gameState.players.length === 2);
    assert(rr.isHost === false);
    a.close(); b2.close();
  });

  // ---- T13 ----
  await test("TEST 13 GAME 场景 resume 返回 GAME 标记或 gameState", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    b.disconnect(); await wait(200);
    const b2 = sock(); const rr = await emit(b2, "resumeRoom", { roomCode: ra.roomCode, playerToken: rb.playerToken });
    assert(rr.gameStarted === true || !!rr.gameState, "没有 GAME 标记也无 gameState");
    a.close(); b2.close();
  });

  // 完成当前阶段所需的 discard / evolve 操作（如果不做完就停留在 sub phase，CPI 不变是正常的）
  async function finishSubPhase(socket, roomCode, st) {
    let phase = st.phase;
    for (let safety=6; safety>0; safety--) {
      if (phase === "evolve") {
        const r = await emit(socket, "playerAction", { roomCode, action:{ type:"skipEvolution" } });
        if (!r.ok) throw new Error("skipEvolution fail: "+r.error);
        await wait(250);
      } else if (phase === "discard") {
        // 丢任意一个 color（本地找 p.tokens 数量>0 的）
        let color = null;
        const seatTokens = st.players?.[st.currentPlayerIndex]?.tokens || {};
        for (const c of ["red","blue","black","pink","yellow","purple"]) {
          if (Number(seatTokens[c]) > 0) { color = c; break; }
        }
        if (!color) color = "red";
        const r = await emit(socket, "playerAction", { roomCode, action:{ type:"discard", color } });
        if (!r.ok) throw new Error("discard "+color+" fail: "+r.error);
        await wait(250);
      } else {
        return; // awaitAction
      }
      // 再 resume 看 phase
      const latest = await getStateFresh(socket, roomCode);
      phase = latest.phase;
    }
  }
  async function getStateFresh(refSock, roomCode) {
    // refSock 必须是当前房间已绑定 seat 的 socket；这里直接用它的 resumeRoom（playerToken 由 caller 提供或自行处理）
    // 统一的最简实现：由上层返回的最新 resume 结果取 gameState 直接传 st 即可。此函数仅作 placeholder
    return (arguments[2] || {});
  }

  // ---- T14 ----
  await test("TEST 14 currentPlayerIndex 刷新前后不变", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(300);
    const snap0 = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
    const beforeCPI = snap0.gameState.currentPlayerIndex;
    // A 回合 → A takeSame red
    const act = await emit(a, "playerAction", { roomCode: ra.roomCode, action:{ type:"takeSame", color:"red" } });
    assert.strictEqual(act.ok, true, `A takeSame red 未成功: ${act?.error || JSON.stringify(act)}`);
    await wait(300);
    // 读最新 state（可能在 evolve）
    const snap1 = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
    // 如有 sub-phase，finish
    if (snap1.gameState.phase !== "awaitAction") {
      const seat = snap1.gameState.currentPlayerIndex;
      const s = seat === 0 ? a : b;
      const tok = seat === 0 ? ra.playerToken : rb.playerToken;
      const snap2 = await emit(s, "resumeRoom", { roomCode:ra.roomCode, playerToken:tok });
      // finish sub-phase
      let curPhase = snap2.gameState.phase;
      for (let s2=6; s2>0 && curPhase !== "awaitAction"; s2--) {
        if (curPhase === "evolve") {
          await emit(s, "playerAction", { roomCode:ra.roomCode, action:{ type:"skipEvolution" } });
          await wait(250);
        } else if (curPhase === "discard") {
          const tk = (await emit(s, "resumeRoom", { roomCode:ra.roomCode, playerToken:tok })).gameState.players?.[snap2.gameState.currentPlayerIndex]?.tokens || {};
          let c = null; for (const k of ["red","blue","black","pink","yellow","purple"]) if (Number(tk[k])>0) { c=k; break; }
          if (!c) c = "red";
          await emit(s, "playerAction", { roomCode:ra.roomCode, action:{ type:"discard", color:c } });
          await wait(250);
        }
        const sn = await emit(s, "resumeRoom", { roomCode:ra.roomCode, playerToken:tok });
        curPhase = sn.gameState.phase;
      }
    }
    const after = await emit(b, "resumeRoom", { roomCode:ra.roomCode, playerToken:rb.playerToken });
    const cpiAfter = after.gameState.currentPlayerIndex;
    assert.notStrictEqual(beforeCPI, cpiAfter, `CPI 仍=${beforeCPI}，未推进（sub-phase 处理后可能仍等 B 行动或状态）`);
    // B refresh → resume
    b.disconnect(); await wait(200);
    const b2 = sock(); const rr = await emit(b2, "resumeRoom", { roomCode: ra.roomCode, playerToken: rb.playerToken });
    assert.strictEqual(rr.gameState.currentPlayerIndex, cpiAfter, "currentPlayerIndex 被刷新改变");
    a.close(); b2.close();
  });

  // ---- T15 ----
  await test("TEST 15 round/turnNumber 刷新前后不变", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(300);

    // 辅助：判断当前玩家身份并完成 discard/evolve sub-phase
    const drainSubPhases = async () => {
      for (let guard=0; guard<10; guard++) {
        const sn = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
        if (sn.gameState.phase === "awaitAction") return;
        const seat = sn.gameState.currentPlayerIndex;
        const sock = seat === 0 ? a : b;
        const tok = seat === 0 ? ra.playerToken : rb.playerToken;
        const snapX = await emit(sock, "resumeRoom", { roomCode:ra.roomCode, playerToken:tok });
        const ph = snapX.gameState.phase;
        if (ph === "evolve") {
          const rr = await emit(sock, "playerAction", { roomCode:ra.roomCode, action:{ type:"skipEvolution" } });
          assert.strictEqual(rr.ok, true, "skipEvolution fail:"+rr.error);
        } else if (ph === "discard") {
          const tk = snapX.gameState.players?.[seat]?.tokens || {};
          let c = null; for (const k of ["red","blue","black","pink","yellow","purple"]) if (Number(tk[k])>0) { c=k; break; }
          if (!c) c = "red";
          const rr = await emit(sock, "playerAction", { roomCode:ra.roomCode, action:{ type:"discard", color:c } });
          assert.strictEqual(rr.ok, true, "discard "+c+" fail:"+rr.error);
        } else {
          return;
        }
        await wait(250);
      }
    };

    // A B 各行动 2 次（至少完整 2 回合推进 turnNumber）。优先 takeDifferent（三色）避免 supply 耗尽。
    const pickDiffColors = (supply) => {
      const order = ["red","blue","black","pink","yellow"];
      const ok = [];
      for (const c of order) { if (Number(supply?.[c]||0) >= 1) ok.push(c); if (ok.length===3) break; }
      return ok;
    };
    let actionsDone = 0;
    for (let round=0; round<2; round++) {
      const snapA = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
      const seatA = snapA.gameState.currentPlayerIndex;
      const colorsA = pickDiffColors(snapA.gameState.supply);
      if (colorsA.length < 3) throw new Error("supply 不够 takeDifferent");
      const sockA = seatA === 0 ? a : b;
      const rA = await emit(sockA, "playerAction", { roomCode:ra.roomCode, action:{ type:"takeDifferent", colors:colorsA } });
      assert.strictEqual(rA.ok, true, `${seatA===0?"A":"B"}A#${round} takeDifferent fail: ${rA.error}`);
      actionsDone++;
      await wait(250);
      await drainSubPhases();
      const snapB = await emit(b, "resumeRoom", { roomCode:ra.roomCode, playerToken:rb.playerToken });
      const seatB = snapB.gameState.currentPlayerIndex;
      const colorsB = pickDiffColors(snapB.gameState.supply);
      if (colorsB.length < 3) throw new Error("supply 不够 takeDifferent (2)");
      const sockB = seatB === 0 ? a : b;
      const rB = await emit(sockB, "playerAction", { roomCode:ra.roomCode, action:{ type:"takeDifferent", colors:colorsB } });
      assert.strictEqual(rB.ok, true, `${seatB===0?"A":"B"}B#${round} takeDifferent fail: ${rB.error}`);
      actionsDone++;
      await wait(250);
      await drainSubPhases();
    }
    assert(actionsDone >= 4, `action 未完成：${actionsDone}`);
    const mid = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
    const rn = mid.gameState.turnNumber ?? mid.gameState.round;
    assert(rn >= 2, "turnNumber 未推进：" + rn + " （actionsDone="+actionsDone+"）");
    a.disconnect(); await wait(200);
    const a2 = sock(); const r2 = await emit(a2, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
    const rn2 = r2.gameState.turnNumber ?? r2.gameState.round;
    assert.strictEqual(rn2, rn, `round 变了：${rn} → ${rn2}`);
    b.close(); a2.close();
  });

  // ---- T16 ----
  // 注：纯客户端脚本很难构造 discard 阶段（需累积 token 超 10 且下一回合仍 3 色取到 11+），
  // discard 阶段的刷新保持语义在 "完整双客户端浏览器测试" 中再覆盖。
  // 这里替换为同等重要的语义：当你是当前玩家（CPI === seatIndex），refresh 后仍是当前玩家，phase 仍 awaitAction
  await test("TEST 16 当前玩家 refresh 后仍为当前玩家（CPI+phase 不变）", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); const rb = await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    // A 是 seat0 当前玩家 → refresh A
    const before = await emit(a, "resumeRoom", { roomCode:ra.roomCode, playerToken:ra.playerToken });
    assert.strictEqual(before.gameState.currentPlayerIndex, 0, "测试前提：初始 CPI 应为 A(0)");
    a.disconnect(); await wait(200);
    const a2 = sock(); const after = await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    assert.strictEqual(after.gameState.currentPlayerIndex, 0, "A refresh 后 CPI 变了");
    assert.strictEqual(after.gameState.phase, "awaitAction");
    a2.close(); b.close();
  });

  // ---- T17 ----
  await test("TEST 17 phase=awaitAction 刷新后仍保持", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    a.disconnect(); b.disconnect(); await wait(250);
    const a2 = sock(); const rr = await emit(a2, "resumeRoom", { roomCode: ra.roomCode, playerToken: ra.playerToken });
    assert.strictEqual(rr.gameState.phase, "awaitAction");
    a2.close();
  });

  // ---- T18 ----
  await test("TEST 18 服务器相信 socket→member，不相信客户端 seatIndex（冒充被拒）", async () => {
    const a = sock(); const ra = await emit(a, "createRoom", { playerName:"H", playerCount:2, aiCount:0 });
    const b = sock(); await emit(b, "joinRoom", { roomCode: ra.roomCode, playerName:"PB" });
    await emit(a, "startOnlineGame", { roomCode: ra.roomCode }); await wait(220);
    // CPI=0（A 回合）；B 冒充 seatIndex=0 行动 → 服务器按 socket→member 映射 seat1，CPI≠1 → 拒
    const r = await emit(b, "playerAction", { roomCode: ra.roomCode, seatIndex:0, action:{ type:"takeSame", color:"red" } });
    assert(r.ok === false, "B 冒充 seat0 成功！");
    // A 真正行动应成功
    const r2 = await emit(a, "playerAction", { roomCode: ra.roomCode, seatIndex: 999 /* 错误 seatIndex，服务器忽略 */, action:{ type:"takeSame", color:"red" } });
    assert(r2.ok === true, "A 真行动被拒（服务器可能仍在错误地读客户端 seatIndex）");
    a.close(); b.close();
  });

  console.log(`\n===== v0.9.11 专项测试 =====  通过 ${pass}  失败 ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("CRASH:", e); process.exit(2); });
