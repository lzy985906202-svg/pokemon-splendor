# 宝可梦璀璨宝石桌游（Pokémon Splendor）

> 基于 Node.js + Express + Socket.IO 的宝可梦主题桌游，支持单机、AI、局域网联机与 Render 公网部署，内置原创 8-bit FC 红白机风格背景音乐。

---

## 特性

| 模块 | 说明 |
| --- | --- |
| 单机模式 | 本地热座（hotseat），无需服务器即可游玩 |
| AI 模式 | MCTS 蒙特卡洛树搜索 AI 对手，可调思考强度 |
| 联机模式 | 房间号 + Socket.IO 实时同步，支持局域网 / 公网 |
| 断线重连 | 同名玩家重连自动恢复座位 |
| 8-bit BGM | Web Audio API 实时合成的 3 首原创小镇曲轮换 |
| 卡牌优化 | WebP 缩略图 + 懒加载 + 7 天浏览器缓存 |
| 视觉风格 | 宝可梦主题背景，半透明面板 + backdrop-filter |
| 完整测试 | `tests.html` 190+ 自动化测试 |

---

## 快速开始

### 环境要求

- Node.js ≥ 20
- 现代浏览器（Chrome / Edge / Firefox / Safari）

### 本地运行

```bash
git clone <your-repo-url>
cd pokemon-splendor
npm install
npm start
```

浏览器访问：

- 游戏：http://localhost:3000
- 健康检查：http://localhost:3000/health
- 静态资源诊断：http://localhost:3000/health/assets
- 测试页：http://localhost:3000/tests.html

### 单机模式

直接访问首页 → 选择「单机模式」→ 配置玩家与 AI 数量 → 开始游戏。

### 联机模式（局域网）

1. 房主访问首页 → 切到「联机模式」→ 输入名字 → 创建房间
2. 房间大厅会显示房间号与局域网访问地址
3. 朋友打开 `http://<房主局域网IP>:3000?room=<房间号>` 即可加入
4. 房主点击「开始游戏」，双方操作实时同步

### 联机模式（公网）

部署到 Render 后，把 `https://<你的服务>.onrender.com?room=<房间号>` 发给朋友即可。详细部署步骤见 [README_DEPLOY.md](./README_DEPLOY.md)。

---

## 项目结构

```
pokemon-splendor/
├── server.js              # Express + Socket.IO 权威状态服务器
├── online.js              # 联机客户端（Socket.IO 连接、房间管理）
├── game.js                # 游戏核心规则与 UI 渲染（含 MCTS AI）
├── bgm.js                 # 8-bit FC 风格 BGM 合成引擎
├── index.html             # 游戏主页面
├── style.css              # 全局样式（Grid 布局 + 响应式）
├── cards.json             # 卡牌数据（不可修改）
├── tests.html / tests.js  # 自动化测试套件
├── package.json           # 依赖与脚本
├── render.yaml            # Render 部署配置
├── README_DEPLOY.md       # 公网部署详细指南
├── assets/
│   ├── backgrounds/       # 背景图（pokemon-game-bg.webp）
│   ├── cards/             # 原始卡牌 PNG
│   ├── cards/thumbs/      # WebP 缩略图（自动生成）
│   ├── tokens/            # 能量球图
│   └── tokens/thumbs/     # 能量球 WebP 缩略图
├── scripts/
│   └── generate-card-thumbnails.js  # WebP 缩略图生成脚本
└── data/                  # 运行时数据
```

---

## 技术栈

- **后端**：Node.js + Express + Socket.IO
- **前端**：原生 HTML / CSS Grid / JavaScript（无框架）
- **AI**：MCTS 蒙特卡洛树搜索
- **音频**：Web Audio API（square / triangle / sawtooth / noise 实时合成）
- **图像**：sharp（构建期 WebP 缩略图生成）
- **测试**：jsdom + tests.html 浏览器测试

---

## 联机游戏机制

- **权威服务器**：所有游戏状态由 `server.js` 维护，客户端只发操作、收广播
- **操作校验**：服务器校验座位归属、回合顺序、行动合法性，非法操作返回 `actionRejected`
- **回合隔离**：非当前玩家操作按钮被禁用（`body.online-not-my-turn` CSS）
- **断线重连**：同名玩家断线后重连，按名字匹配座位恢复状态
- **房间管理**：房间数据存内存，服务器重启会清空（适合小规模朋友游玩）

---

## 背景音乐

3 首原创 8-bit 小镇主题，纯波形合成，无外部音频文件：

| 曲名 | 调式 | BPM | 时长 | 风格 |
| --- | --- | --- | --- | --- |
| 清晨小镇 | C 大调 | 112 | 2:17 | 明亮上行 + 轻拍 hi-hat |
| 黄昏港湾 | F 大调 | 92 | 2:47 | 抒情长音 + Bb 蓝调色彩 |
| 夜晚星空 | A 小调 | 76 | 3:22 | 极慢静谧 + 深低音 pad |

- 顶部 `♪ 音乐` 按钮开关，旁边音量条调节
- 三首曲子无缝衔接循环（调度器每拍重读 BPM）
- 旋律原创，未引用任何已有宝可梦官方曲目

---

## 测试

```bash
# 启动服务器后访问
http://localhost:3000/tests.html
```

测试套件覆盖：卡牌规则、拿球 / 捕捉 / 保留 / 进化 / 丢弃、联机逻辑、断线重连、UI 绑定等。

---

## 部署

### Render（推荐）

详见 [README_DEPLOY.md](./README_DEPLOY.md)，关键步骤：

1. 代码推到 GitHub
2. Render 创建 Web Service，连接仓库
3. Build: `npm install` / Start: `npm start`
4. 部署后访问 `/health` 验证

### render.yaml 已配置

```yaml
services:
  - type: web
    name: pokemon-splendor
    env: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /health
    autoDeploy: yes
```

---

## 项目约束

- `cards.json` 不可修改
- 游戏规则不可更改
- MCTS AI 不可删除
- `tests.html` 必须全部通过
- 不使用 BoardGameArena 的源码、CSS、图片或接口
- 仅允许 UI 布局重构与上线准备相关改动

---

## 版本历史

| 版本 | 说明 |
| --- | --- |
| v0.9.7 | 原创 8-bit FC 风格 BGM 引擎（3 首小镇曲轮换 + 无缝切换） |
| v0.9.6 | Web Audio API 背景音乐基础框架 |
| v0.9.5.4 | 修复联机模式 `getPayInfo` 缺字段导致误报"能量不足" |
| v0.9.5.3 | 公共区卡牌紧凑布局 + 宝可梦主题背景 |
| v0.9.4.1 | 选中卡牌面板 WebP 缩略图优化 |
| v0.9.4 | 卡牌图片懒加载 + WebP 缩略图 + 7 天缓存 |
| v0.9.3 | Render 公网部署适配（显式路由 + 健康检查） |
| v0.9.2 | 真实朋友游玩体验优化（复制房间号 / 移动端横屏） |
| v0.9.1 | 双设备联机验收与修复（断线重连 + 移动适配） |
| v0.9.0 | 多人联机房间版（Node.js + Express + Socket.IO） |

---

## License

仅供学习交流使用。宝可梦相关形象版权归 The Pokémon Company / Nintendo / Game Freak 所有。
项目代码与原创音乐可自由使用。
