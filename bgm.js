/*
 * bgm.js — v0.9.12 BGM MP3 Playlist
 * 3 首 MP3 轮换播放：真新镇 → 古玫镇 → 末白镇 → 循环
 * 使用单个 HTMLAudioElement + ended 事件，不使用 Web Audio API 合成
 *
 * 控制接口：
 *   - BGM.toggle()      开/关，返回播放状态
 *   - BGM.setVolume(v)  设置音量 0-100
 *   - BGM.next()        下一首
 *   - BGM.prev()        上一首
 *   - BGM.getState()    获取当前状态（调试用）
 *
 * 不通过 Socket.IO 同步任何音乐状态。
 * 每个玩家自己控制音乐。
 */
(function () {
  "use strict";

  // ============ 播放列表 ============
  var PLAYLIST = [
    { file: "assets/audio/pallet-town.mp3", name: "真新镇" },
    { file: "assets/audio/oldale-town.mp3", name: "古玫镇" },
    { file: "assets/audio/masara-town.mp3", name: "末白镇" }
  ];

  // ============ 存储 Key ============
  var STORAGE_KEY = "pokemonSplendorAudioSettings.v1";

  // ============ 默认设置 ============
  var DEFAULTS = {
    enabled: true,
    volume: 0.25,
    currentTrack: 0
  };

  // ============ BGM 控制器 ============
  var BGM = {
    audio: null,        // HTMLAudioElement
    playing: false,
    volume: 0.25,
    trackIndex: 0,
    ready: false,

    // ============ 初始化 ============
    _init() {
      if (this.ready) return;
      this.audio = document.getElementById("bgmAudio");
      if (!this.audio) {
        // 如果 HTML 中没有 <audio> 元素，动态创建
        this.audio = document.createElement("audio");
        this.audio.id = "bgmAudio";
        this.audio.preload = "metadata";
        document.body.appendChild(this.audio);
      }
      // 加载设置
      var settings = this._loadSettings();
      this.volume = settings.volume;
      this.trackIndex = settings.currentTrack;
      this.audio.volume = this.volume;
      this.audio.preload = "metadata";

      // ended 事件 → 播放下一首
      var self = this;
      this.audio.addEventListener("ended", function () {
        self._nextTrack();
      });

      // 错误处理（避免 Console 报未处理异常）
      this.audio.addEventListener("error", function (e) {
        // 静默处理，不抛出
      });

      this.ready = true;
    },

    // ============ 设置管理 ============
    _loadSettings() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var s = JSON.parse(raw);
          return {
            enabled: s.enabled !== false,
            volume: typeof s.volume === "number" ? s.volume : DEFAULTS.volume,
            currentTrack: typeof s.currentTrack === "number" && s.currentTrack >= 0 && s.currentTrack < PLAYLIST.length ? s.currentTrack : 0
          };
        }
      } catch (e) {}
      return { enabled: DEFAULTS.enabled, volume: DEFAULTS.volume, currentTrack: DEFAULTS.currentTrack };
    },

    _saveSettings() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          enabled: this.playing,
          volume: this.volume,
          currentTrack: this.trackIndex
        }));
      } catch (e) {}
    },

    // ============ 播放控制 ============
    start() {
      this._init();
      if (!this.audio) return;
      this._loadTrack(this.trackIndex);
      this._play();
    },

    _play() {
      if (!this.audio) return;
      var self = this;
      this.playing = true;
      this.audio.volume = this.volume;

      // 尝试播放，catch autoplay rejection
      var p = this.audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(function () {
          // 浏览器拒绝 autoplay，静默处理
          self.playing = false;
          self._updateUI();
        });
      }
      this._updateUI();
    },

    stop() {
      if (!this.audio) return;
      this.playing = false;
      this.audio.pause();
      this._updateUI();
      this._saveSettings();
    },

    toggle() {
      this._init();
      if (this.playing) {
        this.stop();
        return false;
      }
      // 如果还没加载过曲目，从头开始
      if (!this.audio.src) {
        this.start();
      } else {
        this._play();
      }
      this._saveSettings();
      return true;
    },

    // ============ 曲目切换 ============
    next() {
      this._init();
      this._nextTrack();
      if (this.playing) {
        this._play();
      }
      this._saveSettings();
    },

    prev() {
      this._init();
      this.trackIndex = (this.trackIndex - 1 + PLAYLIST.length) % PLAYLIST.length;
      this._loadTrack(this.trackIndex);
      if (this.playing) {
        this._play();
      }
      this._updateUI();
      this._saveSettings();
    },

    _nextTrack() {
      this.trackIndex = (this.trackIndex + 1) % PLAYLIST.length;
      this._loadTrack(this.trackIndex);
      // 如果正在播放，继续播放下一首
      if (this.playing) {
        this._play();
      }
      this._updateUI();
      this._saveSettings();
    },

    _loadTrack(index) {
      if (!this.audio) return;
      var track = PLAYLIST[index];
      if (!track) return;
      this.trackIndex = index;
      this.audio.src = track.file;
      this.audio.load();
    },

    // ============ 音量 ============
    setVolume(v) {
      this.volume = Math.max(0, Math.min(1, v / 100));
      if (this.audio) {
        this.audio.volume = this.volume;
      }
      this._saveSettings();
    },

    // ============ UI 同步 ============
    _updateUI() {
      var btn = document.getElementById("bgmToggleButton");
      var nameEl = document.getElementById("bgmTrackName");
      var track = PLAYLIST[this.trackIndex];
      var trackName = track ? track.name : "";

      if (btn) {
        if (this.playing) {
          btn.textContent = "🎵";
          btn.setAttribute("aria-pressed", "true");
          btn.classList.remove("bgm-off");
          btn.title = "背景音乐：播放中（点击暂停）";
        } else {
          btn.textContent = "🔇";
          btn.setAttribute("aria-pressed", "false");
          btn.classList.add("bgm-off");
          btn.title = "背景音乐：已暂停（点击播放）";
        }
      }
      if (nameEl) {
        nameEl.textContent = trackName;
      }
    },

    // ============ 获取状态（调试用）============
    getState() {
      return {
        playing: this.playing,
        volume: this.volume,
        trackIndex: this.trackIndex,
        trackName: PLAYLIST[this.trackIndex] ? PLAYLIST[this.trackIndex].name : "",
        playlist: PLAYLIST
      };
    }
  };

  // ============ UI 绑定 ============
  var userInteracted = false;

  function bindUI() {
    var toggleBtn = document.getElementById("bgmToggleButton");
    var volumeRange = document.getElementById("bgmVolumeRange");
    var prevBtn = document.getElementById("bgmPrevButton");
    var nextBtn = document.getElementById("bgmNextButton");

    // 初始化 BGM
    BGM._init();

    // 读取设置：是否默认开启
    var settings = BGM._loadSettings();

    // 设置音量条初始值
    if (volumeRange) {
      volumeRange.value = Math.round(BGM.volume * 100);
    }

    // 更新 UI 为初始状态（暂停）
    BGM.playing = false;
    BGM._updateUI();

    // 音乐按钮：播放 ↔ 暂停
    if (toggleBtn) {
      toggleBtn.addEventListener("click", function () {
        userInteracted = true;
        BGM.toggle();
      });
    }

    // 音量条
    if (volumeRange) {
      volumeRange.addEventListener("input", function (e) {
        BGM.setVolume(Number(e.target.value));
      });
    }

    // 上一首 / 下一首
    if (prevBtn) {
      prevBtn.addEventListener("click", function () {
        userInteracted = true;
        BGM.prev();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        userInteracted = true;
        BGM.next();
      });
    }

    // 用户首次明确交互后自动启动 BGM
    // 交互包括：点击开始游戏、创建房间、加入房间、音乐按钮、任意点击/键盘
    if (settings.enabled) {
      function tryAutostart() {
        if (userInteracted) return;
        userInteracted = true;
        // 只在设置开启时自动启动
        BGM.start();
        document.removeEventListener("click", tryAutostart);
        document.removeEventListener("keydown", tryAutostart);
      }
      document.addEventListener("click", tryAutostart, { once: false });
      document.addEventListener("keydown", tryAutostart, { once: false });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindUI);
  } else {
    bindUI();
  }

  // 暴露到全局
  window.BGM = BGM;
})();
