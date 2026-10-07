# 服务器部署教程

本教程把 PaperForge 的 Web、模型网关、节点管理器和任务 Agent 部署在一台 Linux 服务器上，通过 Caddy 提供 HTTPS。使用自己的模型 API，不需要在线版账号。

## 1. 购买服务器

推荐通过 [雨云购买服务器](https://www.rainyun.com/Laochen_)。此为推广链接，可使用对应的 **8 折优惠**；适用产品、领取条件、有效期及最终优惠以雨云活动和结算页为准。也可以使用已有服务器或其他云服务商。

起步建议使用 **4 核 / 8GB 内存 / 40GB 以上 SSD**，先只允许一个生成任务运行。这是为同机镜像构建、Web 与 Agent 预留余量的配置建议，不是性能实测或并发保证。模型运行在 API 服务端，不需要服务器 GPU；模型 API 费用另计。

选择 Ubuntu 24.04 LTS 等 Docker 支持的系统。服务器须能访问 npm、Python 包索引、容器镜像源和你选用的模型接口。

## 2. 准备域名与 Docker

准备你自己的域名，将 DNS 的 A 记录指向服务器公网地址。如果配置了 AAAA 记录，也要确保 IPv6 可达。安全组放行 TCP 80、443 和你使用的 SSH 端口；教程不向公网暴露 Web、网关或 Docker 管理端口。

登录服务器，按 [Docker 官方 Ubuntu 安装教程](https://docs.docker.com/engine/install/ubuntu/)安装 Docker Engine、Buildx 和 Compose 插件，再安装 Git 与 Python 3。后续命令需要当前账号有 Docker 权限；使用 sudo 的账号请自行在 Docker 命令前加 sudo。

```bash
docker version
docker compose version
git --version
python3 --version
```

Caddy 会为你配置的域名申请 HTTPS 证书；域名解析和 80/443 可达是前提。参考 [Caddy 自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。

## 3. 下载代码

```bash
git clone https://github.com/FlashingChen/Paper-Forge.git
cd Paper-Forge
```

本教程使用 [Compose 模板](../deploy/selfhost.compose.yaml)与 [Caddy 配置](../deploy/Caddyfile)。以下命令都在仓库根目录运行；镜像在服务器构建。

## 4. 生成本实例配置

以下命令只适用于**首次安装**。它会生成管理员密码、会话密钥、执行密钥和节点 token，分别保存到被忽略的配置文件。若文件已存在，命令会停止，不覆盖配置。

```bash
python3 - <<'PYCONFIG'
from pathlib import Path
import secrets, hashlib

web = Path('.env')
node = Path('deploy/.env.node.local')
if web.exists() or node.exists():
    raise SystemExit('配置已存在，请保留原密钥并手动编辑，不要重新生成。')

token = secrets.token_hex(32)
registry = '[{"id":"node-1","tokenHash":"' + hashlib.sha256(token.encode()).hexdigest() + '","concurrency":1}]'
web.write_text('\n'.join([
    'PAPERFORGE_DOMAIN=REPLACE_WITH_YOUR_DOMAIN',
    'PAPERFORGE_IMAGE_TAG=initial',
    'ADMIN_USERNAME=admin',
    'ADMIN_PASSWORD=' + secrets.token_hex(16),
    'ADMIN_QUOTA=100000',
    'SESSION_SECRET=' + secrets.token_hex(32),
    'PAPERFORGE_EXECUTION_SECRET=' + secrets.token_hex(32),
    'PAPERFORGE_EXECUTOR=node',
    'PAPERFORGE_DISPATCH_ENABLED=0',
    'PAPERFORGE_MODEL_ALLOWED_ORIGINS=REPLACE_WITH_MODEL_HTTPS_ORIGIN',
    'PAPERFORGE_NODES=' + registry,
]) + '\n')
node.write_text('\n'.join([
    'PAPERFORGE_NODE_ID=node-1',
    'PAPERFORGE_NODE_TOKEN=' + token,
    'PAPERFORGE_NODE_SCOPE=beta',
    'PAPERFORGE_NODE_VOLUME=paperforge-beta-selfhost',
    'PAPERFORGE_NODE_CONCURRENCY=1',
    'PAPERFORGE_AGENT_MEMORY_MB=2048',
    'PAPERFORGE_AGENT_CPUS=1',
]) + '\n')
web.chmod(0o600)
node.chmod(0o600)
print('配置已生成。编辑 .env 中的域名和模型 origin，保留所有随机密钥。')
PYCONFIG
```

编辑 `.env`，替换这两项：

- `PAPERFORGE_DOMAIN`：自己的域名，不带协议、路径或端口。
- `PAPERFORGE_MODEL_ALLOWED_ORIGINS`：模型接口的 HTTPS origin，即协议和主机部分，不带 `/v1` 等接口路径。多个 origin 用逗号分隔。

完整模型接口地址、模型名及 API 密钥稍后在后台填写。保存管理员密码，用于第一次登录。不要把 `.env` 或 `deploy/.env.node.local` 提交、发到 Issue 或复制进镜像。

这里的 `beta` 只是源码当前支持的资源命名前缀，不会连接 PaperForge 在线版。`PAPERFORGE_NODE_SCOPE` 当前只接受 `beta` 或 `main`；任务卷前缀必须匹配，例如 `paperforge-beta-selfhost`。

## 5. 构建镜像

```bash
docker compose --env-file .env -f deploy/selfhost.compose.yaml config --quiet
docker compose --env-file .env -f deploy/selfhost.compose.yaml build web gateway manager
```

再构建任务 Agent；标签必须与 `.env` 的 `PAPERFORGE_IMAGE_TAG` 一致。初次安装为 `initial`：

```bash
docker build -f Dockerfile.agent -t paperforge-agent:initial .
```

第一次构建会下载 Node、Python 和 Agent 依赖，耗时取决于网络与机器性能。镜像构建与模型调用是不同步骤，此时不会调用模型。

## 6. 先启动 Web，初始化账号和数据库

```bash
docker compose --env-file .env -f deploy/selfhost.compose.yaml up -d web proxy
```

在浏览器打开自己的 HTTPS 域名，使用 `.env` 中的管理员账号和密码登录，填写账号邮箱，再进入管理后台。

在「模型配置」中设置 provider、完整接口地址、视觉模型名称、自己的 API Key 和视觉能力，保存并测试连接。本教程的模型网关支持 HTTPS 的 OpenAI 兼容 Chat Completions 接口；纯文本模型不适用。

**必须先登录并保存配置，再启动网关。** 网关使用 Web 已初始化的数据库，不创建另一套用户库。连接测试成功后，还需要真实生成检查模型的图片输入和工具调用能力。

## 7. 启动网关和执行节点

```bash
docker compose --env-file .env -f deploy/selfhost.compose.yaml up -d gateway manager
docker compose --env-file .env -f deploy/selfhost.compose.yaml ps
```

网关应为 healthy，管理器应持续运行。管理员登录后可打开 `/api/admin/execution` 查看节点心跳。节点管理器拥有 Docker socket 权限；任务容器没有 Docker socket，不接收真实模型密钥，也不挂载控制面数据库。

确认节点在线后，把 `.env` 中 `PAPERFORGE_DISPATCH_ENABLED=0` 改为 `1`，再更新 Web：

```bash
docker compose --env-file .env -f deploy/selfhost.compose.yaml up -d web
```

## 8. 验证首次生成

上传一张清晰且有合法使用权的练习卷照片，确认：

1. 可以创建任务并看到进度。
2. 任务能够完成，预览和下载可用。
3. 下载的 Word / WPS 文档中题目、插图和分页可用。

后续多人使用，可在后台创建用户，或审核注册申请并分配本实例额度。额度不与在线版同步。

## 常见问题

| 现象 | 检查方向 |
| --- | --- |
| HTTPS 无法打开 | DNS、80/443 安全组、是否已有服务占用端口；查看 proxy 日志 |
| 网关不健康 | 是否已登录初始化数据库；若网关在初始化前启动，完成初始化后重启 gateway |
| 管理器一直重启 | 节点 token、scope、任务卷前缀、Docker socket 权限 |
| 任务一直排队 | 管理器心跳、Agent 镜像标签、磁盘余量、并发是否占满 |
| 模型代理不可用 | 允许的 origin 是否匹配接口；接口是否为 HTTPS 的 OpenAI 兼容接口 |
| 任务内存不足 | 提高 Agent 内存上限并保留同机其他服务所需余量 |

查看某个组件的近期日志，例如：

```bash
docker compose --env-file .env -f deploy/selfhost.compose.yaml logs --tail 80 manager
```

日志可能包含运行信息，反馈问题前先检查并遮盖私人内容。

## 更新和备份

升级前备份本实例配置、控制面数据库及上传/结果文件。数据库与任务文件保存在 Compose 的 `control-data` 卷，证书保存在 `caddy-data` 卷；不执行 `docker compose down -v`，该命令会删除数据卷。

更新代码后，将 `.env` 的镜像标签改为新版本，重新构建三个服务及同标签的 Agent，再运行 `up -d`。不要重新生成密钥，也不要用其他实例数据库覆盖现有数据库。已有任务使用原 Agent 镜像，新标签影响新任务。

任务容器和任务卷不会全部自动清理，请制定保留周期；清理范围只限定本实例资源。更多执行语义见 [自部署架构](self-hosting.md)。
