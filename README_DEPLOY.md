# Pokemon Splendor - Render 公网部署指南

本项目是一个基于 Node.js + Express + Socket.IO 的联机桌游服务（不是纯静态站点），
包含完整的 HTTP 静态资源服务与 Socket.IO 实时通信。

## 部署步骤

### 1. 上传代码到 GitHub

- 把整个项目上传到你自己的 GitHub 仓库（public 或 private 均可）。

- 确认仓库根目录包含：`package.json`、`server.js`、`index.html`、`game.js`、`style.css`、`online.js`、`cards.json`、`render.yaml`、`.gitignore`、`assets/`、`tests.html`、`tests.js`。

- **node\_modules 不要上传**（已在 .gitignore 中排除）。

### 2. 在 Render 创建 Web Service

1. 打开 <https://render.com/> 并登录；
2. 点击右上角 **New → Web Service**；
3. 选择刚才上传代码的 GitHub 仓库并连接；
4. 在配置页面填写：

| 配置项                   | 填写内容                                  |
| --------------------- | ------------------------------------- |
| Name                  | `pokemon-splendor`（或你喜欢的名字，部署后的域名会用它） |
| Runtime / Environment | **Node**                              |
| Region                | 任意，建议选离你最近的                           |
| Branch                | `main`（或你的主分支名）                       |
| Build Command         | `npm install`                         |
| Start Command         | `npm start`                           |
| Plan                  | 免费 Free 即可（或按需付费）                     |

1. 页面底部点击 **Create Web Service** 开始部署。
2. 如果项目根目录有 `render.yaml`，Render 会自动读取上述配置。

### 3. 等待部署完成

- Render 会拉取代码 → `npm install` → `npm start`；

- 部署成功后页面会显示你的公网域名，例如：`https://pokemon-splendor.onrender.com`。

### 4. 部署后测试

按顺序验证：

1. **健康检查**：访问 `https://你的服务名.onrender.com/health`，应该返回：

   ```json
   {"ok":true,"status":"running","rooms":0,"time":...}
   ```
2. **首页**：访问 `https://你的服务名.onrender.com/`，能看到游戏开始界面；
3. **创建房间**：切到联机模式，输入房主名字创建房间；
4. **复制加入链接**：点击"复制加入链接"，内容应为 `https://你的服务名.onrender.com?room=XXXX`；
5. **朋友加入**：把链接发给朋友，朋友打开后应自动进入联机模式并填好房间号；
6. **双方同步**：房主开始游戏后，双方操作应实时同步；
7. **测试页**：访问 `https://你的服务名.onrender.com/tests.html`，应全部通过。

## 注意事项

1. **房间数据在内存中**：当前所有房间数据都存在服务器进程内存里。
   Render 服务重启（例如自动休眠、重新部署）后，所有房间会消失，
   进行中的对局需要重新创建房间。

2. **免费服务可能休眠**：Render Free 计划 15 分钟无流量后会休眠。
   朋友第一次打开页面时，若服务器正在唤醒，可能需要 30-60 秒。
   后续访问会很快。

3. **不适合公开大规模运营**：当前版本没有鉴权、限流、持久化房间、
   反作弊等机制，仅适合朋友间小规模游玩。若后续需要公开运营，需要：

   - 把房间状态迁移到 Redis / PostgreSQL；

   - 增加 Socket.IO 集群适配（Redis Adapter）；

   - 加限流和反作弊校验；

   - 考虑 CORS / HTTPS / 域名绑定等。

4. **版本与回滚**：Render 提供每一次部署的历史，出现问题可一键回滚到上一个成功版本。

5. **本地测试**（部署前验证）：

   ```bash
   npm install
   npm start
   # 浏览器打开：
   #   http://localhost:3000/health
   #   http://localhost:3000/
   #   http://localhost:3000/tests.html
   ```

## 本地与公网行为差异

| 场景                       | 复制加入链接示例                                          |
| ------------------------ | ------------------------------------------------- |
| 本地开发 `localhost:3000`    | `http://localhost:3000?room=ABCD`                 |
| 局域网联机 `192.168.1.8:3000` | `http://192.168.1.8:3000?room=ABCD`               |
| Render 公网                | `https://pokemon-splendor.onrender.com?room=ABCD` |

- 公网模式下，房间大厅会显示 **"公网联机模式"**，朋友只需打开链接即可加入，不需要同一 WiFi。

- 本地/局域网模式下，仍会显示局域网 IP 并提示同一 WiFi。

