# 自部署架构

个人本地验证可以按 README 使用 `local` 执行模式。向其他用户提供服务时，采用 `node` 模式，将 Web、模型网关、节点管理器和任务 Agent 分开运行。

## 组件

| 组件 | 构建文件 | 职责 |
| --- | --- | --- |
| Web 控制面 | `Dockerfile` | 页面、账号、任务队列、结果与预览 |
| 模型网关 | `Dockerfile.gateway` | 验证任务权限，代理模型请求 |
| 节点管理器 | `Dockerfile.node` | 领取任务，创建并监控独立任务容器 |
| 任务 Agent | `Dockerfile.agent` | 读取照片、生成文档并回传结果 |

构建你自己的镜像，使用不可变版本标签。镜像构建应在部署服务器或你自己的构建环境完成，且架构须与执行节点一致。

```bash
docker build -f Dockerfile -t paperforge-web:VERSION .
docker build -f Dockerfile.gateway -t paperforge-gateway:VERSION .
docker build -f Dockerfile.node -t paperforge-manager:VERSION .
docker build -f Dockerfile.agent -t paperforge-agent:VERSION .
```

这里的 `VERSION` 是占位符，请替换为你自己的发布标签。

## 控制面与网关

控制面设置登录密钥、初始管理员和模型配置，再设置：

```dotenv
PAPERFORGE_EXECUTOR=node
PAPERFORGE_DISPATCH_ENABLED=0
PAPERFORGE_EXECUTION_SECRET=<独立随机密钥>
PAPERFORGE_CONTROL_URL=<你的控制面HTTPS根地址>
PAPERFORGE_MODEL_GATEWAY_URL=<你的网关HTTPS根地址>
PAPERFORGE_MODEL_ALLOWED_ORIGINS=<允许的模型接口origin，多个用逗号分隔>
PAPERFORGE_NODES=[{"id":"node-1","tokenHash":"<节点token的SHA256十六进制>","concurrency":1}]
```

所有尖括号内容必须替换。网关只接受 HTTPS 的 OpenAI 兼容模型接口；origin 包含协议与主机，不含接口路径。控制面及网关地址不要带路径或参数。网关地址的 `/model/*` 请求必须由反向代理转发至模型网关容器。

控制面与网关需要访问同一份 SQLite 数据库，使用同一 `SESSION_SECRET` 和 `PAPERFORGE_EXECUTION_SECRET`。请自行配置持久化存储和访问权限，避免给网关创建另一份空数据库。网关的模型密钥来自这份数据库中的后台设置。

反向代理应使用 HTTPS、保留或可信地覆盖公开 Host，支持 SSE，并为结果上传留出足够的请求体限制。不要记录 Authorization、Cookie 或请求正文。内部执行接口使用任务凭据，不应再要求浏览器登录。

## 节点管理器

为节点单独生成至少 32 字符的随机 token，将 SHA-256 摘要写入控制面的节点注册表。原始 token 仅保存在节点管理器环境中。

```dotenv
PAPERFORGE_NODE_ID=node-1
PAPERFORGE_NODE_TOKEN=<节点随机token>
PAPERFORGE_CONTROL_URL=<你的控制面HTTPS根地址>
PAPERFORGE_AGENT_IMAGE=paperforge-agent:VERSION
PAPERFORGE_NODE_VOLUME=<你自定义的任务卷前缀>
PAPERFORGE_NODE_SCOPE=selfhost
PAPERFORGE_NODE_CONCURRENCY=1
PAPERFORGE_AGENT_MEMORY_MB=2048
PAPERFORGE_AGENT_CPUS=1
```

`deploy/node.compose.yaml` 是节点管理器模板。指定管理器镜像、节点环境文件、scope 和卷前缀后启动。管理器需要 Docker socket 管理权限；请在专用执行环境运行。任务容器不挂载 Docker socket，不挂载控制面数据库，也不接收真实模型 API 密钥。

任务容器限制 CPU、内存和 PID，每个任务使用独立数据卷。运行中的任务不因 Web 更新而结束；已持久化的交付结果可重传，执行中崩溃不恢复 Agent 会话。

## 启用与维护

1. 启动控制面及模型网关，在后台配置自己的视觉模型并测试连接。
2. 启动节点管理器，通过管理员执行面接口查看心跳及容量。
3. 将 `PAPERFORGE_DISPATCH_ENABLED` 改为 `1`，上传有合法使用权的样本，检查生成、下载和实际 Word 分页。
4. 备份数据库、上传与结果文件；保留加密密钥，升级不得重置已有数据。
5. 按自己的保留周期清理任务容器、任务卷和日志。项目不会自动清理所有任务资源，存储会持续增长；清理须精确限定本实例资源。

源码不包含任何部署者的节点身份、凭据、存储名称或实际服务地址。配置值由部署者自行提供。
