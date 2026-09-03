/*
 * bgm.js — v0.9.6 背景音乐合成引擎
 * 用 Web Audio API 实时合成 3 段宝可梦风格轻快 BGM，循环轮换播放
 * 无外部音频文件依赖，零网络请求
 *
 * 控制接口：
 *   - BGM.init()        初始化（需在用户首次交互后调用）
 *   - BGM.toggle()      开/关
 *   - BGM.setVolume(v)  设置音量 0-100
 *
 * 数据驱动：每段音乐由 melody/bass/pad 三个音轨组成
 * 音符用 "C4" "D#4" "R"(休止) 表示，beat 为起始拍位，dur 为持续拍数
 */
(function () {
  "use strict";

  // ============ 音符频率表 ============
  // 覆盖 C2-C6，含升降号
  const NOTE_FREQ = (function () {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const table = {};
    for (let oct = 2; oct <= 6; oct++) {
      for (let i = 0; i < 12; i++) {
        // C4 = 261.63Hz，每升一个半音 ×2^(1/12)
        const baseIdx = (4 - 4) * 12; // C4 对应的起始
        const semitonesFromC4 = (oct - 4) * 12 + i;
        table[names[i] + oct] = 261.63 * Math.pow(2, semitonesFromC4 / 12);
      }
    }
    return table;
  })();

  function noteToFreq(name) {
    if (name === "R" || !name) return 0; // 休止
    return NOTE_FREQ[name] || 0;
  }

  // ============ 3 段音乐数据 ============
  // 120 BPM → 1 拍 = 0.5 秒，4/4 拍 → 1 小节 = 4 拍 = 2 秒
  // 每段 8 小节 = 32 拍 = 16 秒，循环 2 次后换下一段

  // 段1：晨光出发（C 大调，明亮上升，类似出发/道馆）
  const TRACK_1 = {
    name: "晨光出发",
    bpm: 124,
    melody: [
      // 第 1-2 小节：明亮的上升动机
      ["C5", 0, 0.5], ["E5", 0.5, 0.5], ["G5", 1, 1], ["E5", 2, 0.5], ["D5", 2.5, 0.5], ["C5", 3, 1],
      // 第 3-4 小节：呼应下降
      ["A4", 4, 0.5], ["C5", 4.5, 0.5], ["E5", 5, 1], ["D5", 6, 0.5], ["C5", 6.5, 0.5], ["G4", 7, 1],
      // 第 5-6 小节：副动机，跳跃到高音
      ["G5", 8, 0.5], ["F5", 8.5, 0.5], ["E5", 9, 0.5], ["D5", 9.5, 0.5], ["C5", 10, 1], ["E5", 11, 1],
      // 第 7-8 小节：收束回到主音
      ["D5", 12, 0.5], ["E5", 12.5, 0.5], ["G5", 13, 1], ["E5", 14, 0.5], ["D5", 14.5, 0.5], ["C5", 15, 1],
    ],
    bass: [
      ["C3", 0, 2], ["G2", 2, 2],
      ["F2", 4, 2], ["C3", 6, 2],
      ["G2", 8, 2], ["E3", 10, 2],
      ["F2", 12, 2], ["G2", 14, 2],
    ],
    pad: [
      ["C4", 0, 4], ["F4", 4, 4],
      ["G4", 8, 4], ["C4", 12, 4],
    ],
  };

  // 段2：对战时刻（G 大调，节奏加快，带切分）
  const TRACK_2 = {
    name: "对战时刻",
    bpm: 132,
    melody: [
      // 第 1-2 小节：果断的短促动机
      ["G5", 0, 0.25], ["G5", 0.25, 0.25], ["B4", 0.5, 0.5], ["D5", 1, 0.5], ["G5", 1.5, 0.5],
      ["A5", 2, 0.5], ["G5", 2.5, 0.5], ["F#5", 3, 1],
      // 第 3-4 小节：上升回应
      ["D5", 4, 0.25], ["E5", 4.25, 0.25], ["F#5", 4.5, 0.5], ["G5", 5, 0.5], ["A5", 5.5, 0.5],
      ["B5", 6, 1], ["A5", 7, 1],
      // 第 5-6 小节：跳跃副题
      ["G5", 8, 0.5], ["D5", 8.5, 0.5], ["G5", 9, 0.5], ["B5", 9.5, 0.5],
      ["A5", 10, 0.5], ["G5", 10.5, 0.5], ["F#5", 11, 1],
      // 第 7-8 小节：收束到 G
      ["D5", 12, 0.5], ["G5", 12.5, 0.5], ["B5", 13, 0.5], ["A5", 13.5, 0.5],
      ["G5", 14, 1.5], ["R", 15.5, 0.5],
    ],
    bass: [
      ["G2", 0, 1.5], ["G2", 1.5, 0.5], ["D3", 2, 2],
      ["D3", 4, 1.5], ["D3", 5.5, 0.5], ["G2", 6, 2],
      ["C3", 8, 1.5], ["C3", 9.5, 0.5], ["D3", 10, 2],
      ["D3", 12, 2], ["G2", 14, 2],
    ],
    pad: [
      ["G3", 0, 4], ["D4", 4, 4],
      ["C4", 8, 4], ["D4", 12, 4],
    ],
  };

  // 段3：宁静小镇（F 大调，舒缓，三连音感）
  const TRACK_3 = {
    name: "宁静小镇",
    bpm: 116,
    melody: [
      // 第 1-2 小节：舒缓的抒情旋律
      ["F5", 0, 1], ["E5", 1, 0.5], ["F5", 1.5, 0.5], ["A5", 2, 1.5], ["G5", 3.5, 0.5],
      // 第 3-4 小节：温柔下降
      ["F5", 4, 1], ["C5", 5, 0.5], ["D5", 5.5, 0.5], ["F5", 6, 1.5], ["C5", 7.5, 0.5],
      // 第 5-6 小节：上升到高潮
      ["A5", 8, 1], ["G5", 9, 0.5], ["A5", 9.5, 0.5], ["C6", 10, 1.5], ["A5", 11.5, 0.5],
      // 第 7-8 小节：回落收束
      ["F5", 12, 1], ["D5", 13, 0.5], ["F5", 13.5, 0.5], ["C5", 14, 2],
    ],
    bass: [
      ["F2", 0, 2], ["C3", 2, 2],
      ["Bb2", 4, 2], ["F2", 6, 2],
      ["F2", 8, 2], ["A2", 10, 2],
      ["Bb2", 12, 2], ["C3", 14, 2],
    ],
    pad: [
      ["F4", 0, 4], ["Bb3", 4, 4],
      ["F4", 8, 4], ["C4", 12, 4],
    ],
  };

  const TRACKS = [TRACK_1, TRACK_2, TRACK_3];

  // ============ 合成引擎 ============
  const BGM = {
    ctx: null,
    masterGain: null,
    playing: false,
    volume: 0.45, // 0-1，对应 UI 45%
    trackIndex: 0,
    loopCount: 0, // 当前段已循环次数，达到 2 次换下一段
    // 调度器状态
    nextNoteTime: 0, // 下一批音符的调度起点（AudioContext 时间）
    currentBeat: 0, // 当前段内已调度的拍数
    schedulerTimer: null,
    activeNodes: [], // 当前正在响的节点，用于停止时清理

    init() {
      if (this.ctx) return;
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
    },

    start() {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") this.ctx.resume();
      if (this.playing) return;
      this.playing = true;
      this.trackIndex = 0;
      this.loopCount = 0;
      this.currentBeat = 0;
      this.nextNoteTime = this.ctx.currentTime + 0.05;
      this._tick();
    },

    stop() {
      this.playing = false;
      if (this.schedulerTimer) {
        clearTimeout(this.schedulerTimer);
        this.schedulerTimer = null;
      }
      // 立即静音并清理当前节点，避免尾音拖长
      if (this.masterGain && this.ctx) {
        const t = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(this.volume, t);
      }
      this.activeNodes.forEach((n) => {
        try { n.stop(); } catch (e) {}
      });
      this.activeNodes = [];
    },

    toggle() {
      if (this.playing) {
        this.stop();
        return false;
      }
      this.start();
      return true;
    },

    setVolume(v) {
      // v: 0-100
      this.volume = Math.max(0, Math.min(1, v / 100));
      if (this.masterGain && this.ctx) {
        const t = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setTargetAtTime(this.volume, t, 0.02);
      }
    },

    // ============ 内部：lookahead 调度器 ============
    _tick() {
      if (!this.playing || !this.ctx) return;
      const track = TRACKS[this.trackIndex];
      const secPerBeat = 60 / track.bpm;
      const lookahead = 0.1; // 提前 100ms 调度
      const interval = 25; // 每 25ms 检查一次

      // 在 nextNoteTime 到 currentTime+lookahead 之间调度所有应响的音符
      while (this.nextNoteTime < this.ctx.currentTime + lookahead) {
        this._scheduleBeat(track, this.currentBeat, this.nextNoteTime, secPerBeat);
        this.currentBeat++;
        this.nextNoteTime += secPerBeat;

        // 一段循环完毕（8 小节 = 32 拍）
        if (this.currentBeat >= 32) {
          this.currentBeat = 0;
          this.loopCount++;
          if (this.loopCount >= 2) {
            // 切换到下一段
            this.loopCount = 0;
            this.trackIndex = (this.trackIndex + 1) % TRACKS.length;
          }
        }
      }

      this.schedulerTimer = setTimeout(() => this._tick(), interval);
    },

    _scheduleBeat(track, beat, time, secPerBeat) {
      // 调度在 beat 拍开始的 melody/bass/pad 音符
      // melody: 查找 beat 起始的音符
      track.melody.forEach((n) => {
        if (n[1] === beat) this._playNote(n, time, secPerBeat, "square", 0.18);
      });
      track.bass.forEach((n) => {
        if (n[1] === beat) this._playNote(n, time, secPerBeat, "triangle", 0.22);
      });
      track.pad.forEach((n) => {
        if (n[1] === beat) this._playNote(n, time, secPerBeat, "sine", 0.08);
      });
    },

    _playNote(noteData, time, secPerBeat, type, peakGain) {
      const [name, beat, durBeats] = noteData;
      const freq = noteToFreq(name);
      if (freq === 0) return; // 休止
      const dur = durBeats * secPerBeat;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(this.masterGain);

      // ADSR 包络
      const attack = 0.01;
      const decay = 0.08;
      const sustainLevel = peakGain * 0.7;
      const release = Math.min(0.12, dur * 0.3);
      const sustainDur = Math.max(0.05, dur - release);

      gain.gain.setValueAtTime(0, time);
      gain.gain.linearRampToValueAtTime(peakGain, time + attack);
      gain.gain.linearRampToValueAtTime(sustainLevel, time + attack + decay);
      gain.gain.setValueAtTime(sustainLevel, time + attack + decay + sustainDur);
      gain.gain.linearRampToValueAtTime(0, time + dur);

      osc.start(time);
      osc.stop(time + dur + 0.05);

      // 记录以便 stop() 时清理（只保留可能还在响的）
      this.activeNodes.push(osc);
      // 定时清理已结束的节点引用
      const cleanupAt = (time + dur + 0.1) * 1000 - this.ctx.currentTime * 1000;
      setTimeout(() => {
        const idx = this.activeNodes.indexOf(osc);
        if (idx >= 0) this.activeNodes.splice(idx, 1);
      }, Math.max(50, cleanupAt));
    },
  };

  // ============ UI 绑定 ============
  // 浏览器自动播放策略：必须等用户首次交互才能启动 AudioContext
  let userInteracted = false;
  let pendingAutostart = true; // 默认尝试自动开始（配置：默认开）

  function bindUI() {
    const toggleBtn = document.getElementById("bgmToggleButton");
    const volumeRange = document.getElementById("bgmVolumeRange");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        userInteracted = true;
        const playing = BGM.toggle();
        toggleBtn.setAttribute("aria-pressed", String(playing));
        toggleBtn.textContent = playing ? "♪ 音乐" : "♪ 关";
        toggleBtn.classList.toggle("bgm-off", !playing);
      });
    }

    if (volumeRange) {
      volumeRange.addEventListener("input", (e) => {
        BGM.setVolume(Number(e.target.value));
      });
    }

    // 首次用户交互（点击/按键）时自动启动 BGM
    function tryAutostart() {
      if (userInteracted || !pendingAutostart) return;
      userInteracted = true;
      BGM.start();
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-pressed", "true");
        toggleBtn.textContent = "♪ 音乐";
      }
      document.removeEventListener("click", tryAutostart);
      document.removeEventListener("keydown", tryAutostart);
    }
    document.addEventListener("click", tryAutostart, { once: false });
    document.addEventListener("keydown", tryAutostart, { once: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindUI);
  } else {
    bindUI();
  }

  // 暴露到全局（便于调试）
  window.BGM = BGM;
})();
