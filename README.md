这是一个为 Node.js 版本（V27.0 最终静默版）准备的详细 `README.md` 文件。它包含了针对 Node.js 生态优化的部署方式（如 PM2），同时也包含了 Docker 和 Systemd 方案。

你可以直接将以下内容复制到你的 GitHub 仓库的 `README.md` 文件中。

---

# NodeJS XHTTP High-Performance Proxy

这是一个基于 Node.js 原生模块和 `ws` 库构建的高性能 XHTTP/WebSocket 代理服务器。

本项目是经过大量迭代优化的 **V27.0 最终静默生产版**。它引入了独创的 **"全量广播 (Total Broadcast)"** 和 **"确认与分流 (Ack & Divert)"** 机制，彻底解决了 Xray 在 `packet-up` 和 `auto` 模式下因短连接导致的握手失败问题。

## 🌟 核心特性

* **全模式兼容**：完美支持 Xray 的 `stream-up`、`stream-none`、`packet-up` 和 `auto` 模式。
* **全量广播握手**：握手响应包会同时写入 GET 和 POST 通道，确保客户端无论监听哪个通道都能收到确认，解决“死锁”问题。
* **智能分流策略**：针对 Packet 模式的短连接特征，实现了自动 ACK 和数据回退机制。
* **极致静默**：控制台无任何日志输出，隐蔽性极强。
* **伪装服务**：根路径访问返回普通的 HTML 页面，伪装成普通 Web 服务。
* **原生高性能**：基于 Node.js 事件驱动模型，高效处理高并发连接。

## 🛠 环境要求

* **Node.js**: v16.0 或更高版本
* **依赖库**: `ws`

## 🚀 快速部署指南

提供了四种部署方式，推荐使用 **Docker** 或 **PM2** 进行生产环境部署。

### 方式一：Docker 部署（最推荐）

1. **准备文件**
在项目根目录创建 `Dockerfile`：
```dockerfile
FROM node:18-alpine

WORKDIR /app

# 复制源代码
COPY index.js .

# 安装依赖
RUN npm install ws

# 暴露端口
EXPOSE 3241

# 启动命令
CMD ["node", "index.js"]

```


2. **构建镜像**
```bash
docker build -t xhttp-node .

```


3. **启动容器**
*请将 `your-uuid-here` 替换为你生成的 UUID。*
```bash
docker run -d \
  --name xhttp-server \
  --restart always \
  -p 3241:3241 \
  -e UUID="b389e09c-4e31-40da-a56c-433f507e615a" \
  -e PORT=3241 \
  xhttp-node

```



---

### 方式二：PM2 进程管理（Node.js 常用）

PM2 是 Node.js 生产环境标准的进程管理工具，支持自动重启和后台运行。

1. **安装 PM2 和依赖**
```bash
npm install -g pm2
npm install ws

```


2. **启动服务**
```bash
# 设置环境变量并启动
UUID="b389e09c-4e31-40da-a56c-433f507e615a" PORT=3241 pm2 start index.js --name xhttp

```


3. **保存状态 (开机自启)**
```bash
pm2 save
pm2 startup

```



---

### 方式三：Linux Systemd 守护进程

适合没有 Docker 环境的 VPS。

1. **上传代码**
将 `index.js` 上传到服务器，例如 `/opt/xhttp/index.js`。
2. **安装依赖**
进入目录并安装依赖：
```bash
cd /opt/xhttp
npm install ws

```


3. **创建服务文件**
创建文件 `/etc/systemd/system/xhttp.service`：
```ini
[Unit]
Description=XHTTP NodeJS Proxy Service
After=network.target

[Service]
Type=simple
User=root
# 请修改为你实际的 UUID
Environment="UUID=b389e09c-4e31-40da-a56c-433f507e615a"
Environment="PORT=3241"
# Environment="WSPATH=path"

# 请确保 node 路径正确 (可通过 `which node` 查看)
ExecStart=/usr/bin/node /opt/xhttp/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target

```


4. **启动服务**
```bash
systemctl daemon-reload
systemctl enable xhttp
systemctl start xhttp

```



---

### 方式四：手动运行（测试用）

1. **安装依赖**
```bash
npm install ws

```


2. **设置环境变量并运行**
* **Linux/Mac**:
```bash
export UUID="b389e09c-4e31-40da-a56c-433f507e615a"
export PORT=3241
node index.js

```


* **Windows (CMD)**:
```cmd
set UUID=b389e09c-4e31-40da-a56c-433f507e615a
set PORT=3241
node index.js

```





## ⚙️ 环境变量说明

| 变量名 | 说明 | 默认值 | 示例 |
| --- | --- | --- | --- |
| `UUID` | **必填**，用于鉴权的 UUID | (内置测试UUID) | `550e8400-e29b-41d4-a716-446655440000` |
| `PORT` | 服务监听端口 | `3241` | `8080` |
| `WSPATH` | XHTTP/WS 的路径 | UUID 前8位 | `mypath` |

## 📱 客户端配置参考 (Xray/V2Ray)

本服务端支持 **VLESS** 和 **Trojan** 协议。

### VLESS + XHTTP (推荐)

这是性能最好且兼容性最强的配置方式。

```json
{
  "outbounds": [
    {
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "你的服务器IP",
            "port": 3241,
            "users": [
              {
                "id": "b389e09c-4e31-40da-a56c-433f507e615a",
                "encryption": "none"
              }
            ]
          }
        ]
      },
      "streamSettings": {
        "network": "xhttp",
        "xhttpSettings": {
          "path": "/b389e09c", 
          "mode": "auto" 
        }
      }
    }
  ]
}

```

*注意：`path` 默认为 UUID 的前 8 位（不含横杠）。如果使用了 `WSPATH` 环境变量，请填写该变量的值。*

### WebSocket 模式

如果你需要使用传统的 WebSocket 模式，本服务端也完全兼容。

```json
"streamSettings": {
  "network": "ws",
  "wsSettings": {
    "path": "/b389e09c"
  }
}

```

## ⚠️ 注意事项

1. **静默运行**：启动后控制台**不会有任何输出**。这是为了隐蔽性设计的。请通过 `netstat -tlnp | grep node` 或 `docker ps` 确认端口是否在监听。
2. **根路径**：访问 `http://ip:port/` 会显示 "NodeJS Server"，这是为了伪装流量特征。
3. **UUID**：请务必修改默认的 `UUID`，否则会有安全风险。

## 📄 License

MIT License
