# 部署指南 (Deployment Guide)

## 目录

1. [系统要求](#1-系统要求)
2. [快速开始](#2-快速开始)
3. [本地部署](#3-本地部署)
4. [服务器部署](#4-服务器部署)
5. [桌面应用构建](#5-桌面应用构建)
6. [Docker 部署](#6-docker-部署)
7. [生产环境配置](#7-生产环境配置)
8. [故障排除](#8-故障排除)

## 1. 系统要求

### 1.1 硬件要求

| 组件 | 最低要求 | 推荐配置 |
|------|----------|----------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 1 GB | 10 GB+ SSD |
| 网络 | 互联网连接 | 稳定高速连接 |

### 1.2 软件要求

| 软件 | 版本 | 说明 |
|------|------|------|
| Bun | 1.3+ | 运行时和包管理器 |
| Git | 2.x+ | 版本控制 |
| Node.js | 18+ | 部分工具依赖 |

### 1.3 支持的操作系统

- **macOS**: 12+ (Monterey 及更高版本)
- **Linux**: Ubuntu 20.04+, Debian 11+, CentOS 8+, Arch Linux
- **Windows**: Windows 10/11 (WSL2 推荐)

## 2. 快速开始

### 2.1 一键安装

```bash
# 使用官方安装脚本
curl -fsSL https://opencode.ai/install | bash

# 验证安装
opencode --version
```

### 2.2 首次运行

```bash
# 在项目目录中启动
opencode

# 配置 API 密钥（在 TUI 中输入）
/connect
```

## 3. 本地部署

### 3.1 从源码构建

#### 步骤 1：克隆仓库

```bash
git clone https://github.com/anomalyco/opencode.git
cd opencode
```

#### 步骤 2：安装依赖

```bash
# 安装 Bun（如果尚未安装）
curl -fsSL https://bun.sh/install | bash

# 安装项目依赖
bun install
```

#### 步骤 3：构建核心

```bash
# 构建本地可执行文件
./packages/opencode/script/build.ts --single

# 构建产物位置
./packages/opencode/dist/opencode-<platform>/bin/opencode
```

#### 步骤 4：运行

```bash
# 开发模式
bun run dev

# 或使用构建的二进制文件
./packages/opencode/dist/opencode-darwin-arm64/bin/opencode
```

### 3.2 配置环境

#### 环境变量

```bash
# API 密钥（可选，也可通过 /connect 配置）
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# 自定义安装目录
export OPENCODE_INSTALL_DIR="/usr/local/bin"

# 禁用外部 Skill
export OPENCODE_DISABLE_EXTERNAL_SKILLS="true"

# 配置目录
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
```

#### 配置文件

创建 `~/.config/opencode/opencode.jsonc`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "claude-sonnet-4",
  "provider": {
    "anthropic": {
      "name": "Anthropic",
      "models": {
        "claude-sonnet-4": { "name": "Claude Sonnet 4" }
      }
    }
  }
}
```

### 3.3 目录结构

```
~/.opencode/                  # OpenCode 主目录（如果使用默认安装路径）
~/.config/opencode/           # 配置目录
  ├── opencode.jsonc          # 主配置文件
  ├── skills/                 # 自定义 Skill
  └── tools/                  # 自定义工具

~/.local/share/opencode/      # 数据目录
  ├── auth.json               # API 密钥存储
  ├── sessions/               # 会话数据
  └── cache/                  # 缓存数据

~/.cache/opencode/            # 临时缓存
  └── skills/                 # 下载的远程 Skill
```

## 4. 服务器部署

### 4.1 启动无头服务器

```bash
# 默认端口 4096
opencode serve

# 指定端口
opencode serve --port 8080

# 指定主机
opencode serve --host 0.0.0.0 --port 8080
```

### 4.2 使用 systemd（Linux）

创建 `/etc/systemd/system/opencode.service`：

```ini
[Unit]
Description=OpenCode Server
After=network.target

[Service]
Type=simple
User=opencode
WorkingDirectory=/home/opencode
ExecStart=/usr/local/bin/opencode serve --host 0.0.0.0 --port 4096
Restart=always
RestartSec=5
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable opencode
sudo systemctl start opencode
sudo systemctl status opencode
```

### 4.3 使用 PM2

```bash
# 安装 PM2
npm install -g pm2

# 启动
pm2 start "opencode serve --port 4096" --name opencode

# 保存配置
pm2 save
pm2 startup
```

### 4.4 使用 Docker Compose

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  opencode:
    image: opencode:latest
    ports:
      - "4096:4096"
    volumes:
      - ./data:/data
      - ./config:/config
    environment:
      - OPENCODE_DATA_DIR=/data
      - OPENCODE_CONFIG_DIR=/config
    restart: unless-stopped
```

启动：

```bash
docker-compose up -d
```

### 4.5 Nginx 反向代理

```nginx
server {
    listen 80;
    server_name opencode.example.com;
    
    location / {
        proxy_pass http://localhost:4096;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # WebSocket 支持
        proxy_read_timeout 86400;
    }
}
```

### 4.6 SSL/TLS 配置

使用 Let's Encrypt：

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d opencode.example.com

# 自动续期
sudo certbot renew --dry-run
```

## 5. 桌面应用构建

### 5.1 Electron 桌面应用

#### 环境准备

```bash
# 安装依赖
cd packages/desktop-electron
bun install
```

#### 开发模式

```bash
# 启动开发服务器
bun run dev

# 或从根目录
bun --cwd packages/desktop-electron run dev
```

#### 构建

```bash
# 构建应用
bun run build

# 打包
bun run package

# 产物位置
out/opencode-desktop-<platform>-<arch>/
```

### 5.2 Tauri 桌面应用

#### 环境准备

需要安装 Rust 工具链：

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装 Tauri 依赖（macOS/Linux）
# 参考: https://v2.tauri.app/start/prerequisites/
```

#### 开发模式

```bash
# 从根目录启动
cd packages/desktop
bun run tauri dev

# 或从根目录
bun run dev:desktop
```

#### 构建

```bash
# 构建生产版本
bun run tauri build

# 产物位置
src-tauri/target/release/bundle/
```

### 5.3 多平台构建

#### GitHub Actions

```yaml
# .github/workflows/build-desktop.yml
name: Build Desktop Apps

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    strategy:
      matrix:
        platform: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun --cwd packages/desktop-electron run build
```

## 6. Docker 部署

### 6.1 使用官方镜像

```bash
# 拉取镜像
docker pull opencode/opencode:latest

# 运行容器
docker run -d \
  --name opencode \
  -p 4096:4096 \
  -v $(pwd)/data:/data \
  -v $(pwd)/config:/config \
  opencode/opencode:latest
```

### 6.2 自定义 Dockerfile

```dockerfile
FROM oven/bun:1.3-alpine

WORKDIR /app

# 安装系统依赖
RUN apk add --no-cache git

# 复制源码
COPY . .

# 安装依赖
RUN bun install

# 构建
RUN bun run --cwd packages/opencode build

# 暴露端口
EXPOSE 4096

# 启动命令
CMD ["bun", "run", "--cwd", "packages/opencode", "serve", "--host", "0.0.0.0"]
```

构建并运行：

```bash
# 构建镜像
docker build -t opencode:custom .

# 运行容器
docker run -d \
  --name opencode \
  -p 4096:4096 \
  -v $(pwd)/data:/app/data \
  opencode:custom
```

### 6.3 Kubernetes 部署

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode
spec:
  replicas: 1
  selector:
    matchLabels:
      app: opencode
  template:
    metadata:
      labels:
        app: opencode
    spec:
      containers:
      - name: opencode
        image: opencode/opencode:latest
        ports:
        - containerPort: 4096
        env:
        - name: OPENCODE_PORT
          value: "4096"
        volumeMounts:
        - name: data
          mountPath: /data
        - name: config
          mountPath: /config
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: opencode-data
      - name: config
        configMap:
          name: opencode-config
---
apiVersion: v1
kind: Service
metadata:
  name: opencode
spec:
  selector:
    app: opencode
  ports:
  - port: 4096
    targetPort: 4096
  type: ClusterIP
```

部署：

```bash
kubectl apply -f opencode-deployment.yaml
```

## 7. 生产环境配置

### 7.1 安全配置

#### 防火墙设置

```bash
# UFW (Ubuntu)
sudo ufw allow 4096/tcp
sudo ufw enable

# firewalld (CentOS)
sudo firewall-cmd --permanent --add-port=4096/tcp
sudo firewall-cmd --reload

# iptables
sudo iptables -A INPUT -p tcp --dport 4096 -j ACCEPT
```

#### API 密钥管理

```bash
# 使用环境变量
export OPENCODE_API_KEY_SECRET=$(cat /run/secrets/api_key)

# 或使用密钥管理服务
export OPENAI_API_KEY=$(aws secretsmanager get-secret-value --secret-id opencode/openai)
```

### 7.2 监控与日志

#### 日志配置

```bash
# 查看日志
journalctl -u opencode -f

# 日志轮转
sudo tee /etc/logrotate.d/opencode <<EOF
/var/log/opencode/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0644 opencode opencode
}
EOF
```

#### 健康检查

```bash
# 添加健康检查端点
curl http://localhost:4096/health

# 预期响应
{"status": "ok"}
```

### 7.3 备份策略

```bash
#!/bin/bash
# backup-opencode.sh

BACKUP_DIR="/backup/opencode"
DATE=$(date +%Y%m%d_%H%M%S)

# 备份会话数据
tar -czf "$BACKUP_DIR/sessions_$DATE.tar.gz" ~/.local/share/opencode/sessions/

# 备份配置
tar -czf "$BACKUP_DIR/config_$DATE.tar.gz" ~/.config/opencode/

# 保留最近 7 天的备份
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +7 -delete
```

添加定时任务：

```bash
# 每天凌晨 2 点备份
0 2 * * * /path/to/backup-opencode.sh
```

### 7.4 性能优化

#### 数据库优化

```bash
# SQLite 优化
sqlite3 ~/.local/share/opencode/sessions.db "VACUUM;"
sqlite3 ~/.local/share/opencode/sessions.db "ANALYZE;"
```

#### 缓存配置

```json
{
  "cache": {
    "maxSize": "100MB",
    "ttl": 86400
  }
}
```

## 8. 故障排除

### 8.1 常见问题

#### Q: 端口被占用

```bash
# 查找占用端口的进程
lsof -i :4096
# 或
netstat -tulpn | grep 4096

# 终止进程
kill -9 <PID>

# 或使用其他端口
opencode serve --port 8080
```

#### Q: 权限不足

```bash
# 检查目录权限
ls -la ~/.config/opencode/
ls -la ~/.local/share/opencode/

# 修复权限
chmod -R 755 ~/.config/opencode/
chmod -R 755 ~/.local/share/opencode/
```

#### Q: 构建失败

```bash
# 清理缓存
bun pm cache rm
rm -rf node_modules bun.lock

# 重新安装
bun install
```

### 8.2 调试模式

```bash
# 启用调试日志
DEBUG=opencode:* opencode serve

# 或设置环境变量
export DEBUG=opencode:*
opencode serve
```

### 8.3 获取帮助

- **GitHub Issues**: https://github.com/anomalyco/opencode/issues
- **Discord**: https://opencode.ai/discord
- **文档**: https://opencode.ai/docs
