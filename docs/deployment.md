# 正式部署与运维

## 准备

- 中国大陆 Linux 云服务器，Docker Engine + Compose v2；建议起步 2 核 4 GB，随实际数据和并发评估调整。
- 已备案的域名，A/AAAA 记录指向服务器；公网开放 80/443，SSH 限定管理来源。不公开 3000/5432 端口。
- 已认证并完成备案的小程序账号、真实 AppID/AppSecret、已启用且有余额的手机号实时验证能力。
- 两个私有 COS 桶：图片桶与独立备份桶。按桶和前缀分配不同的最小权限密钥；图片桶需读/写/删对象，备份桶需读/写/列举/删对象。
- 门店实际名称、电话、Logo 与隐私保护指引。云账号、域名与微信账号应由门店持有。

## 部署

1. 将源码放在服务器目录。复制 `ops/production.env.example` 为根目录 `.env` 并填写全部占位值；不要沿用本地 `.env`。
2. 使用随机生成的密码与备份密钥。例如 `openssl rand -hex 32`；数据库密码使用 64 位十六进制，避免连接串转义问题。备份密钥单独生成并离线保存。`.env` 权限设为 `600`。
3. `ADMIN_ORIGIN` 与 `PUBLIC_URL` 均为实际后台的 HTTPS Origin，不带末尾 `/`；`SITE_DOMAIN` 只填写域名。小程序可与后台使用同一域名，API 前缀为 `/api`。
4. 执行：

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
curl --fail https://你的域名/api/health
```

Compose 启动 PostgreSQL 17、API、静态网页/HTTPS 代理、备份与监控。Caddy 自动申请和续期 HTTPS 证书。API 首次启动自动迁移并创建单一管理员；`ADMIN_INITIAL_PASSWORD` 只在管理员不存在时使用，修改环境变量不会重置已有密码。

5. 用初始密码登录，修改密码并配置门店资料。删除生产环境中的 `ADMIN_INITIAL_PASSWORD` 值（已有账号可正常启动）。确认没有演示会员。
6. 完成 `wechat-release.md` 中的实际微信联调。线上可用需要微信审核通过，不能仅凭本地构建成功认定。

## 数据与运行边界

数据库放在 Docker 持久卷 `postgres_data`，数据和容器生命周期分离。日常更新执行 `docker compose build && docker compose up -d`。**不要使用 `docker compose down -v`，这会删除数据库卷。**

API 默认最多 10 个数据库连接；头像和 Logo 上传均限制为 5 MB/1,600 万像素，头像输出最大 512×512，Logo 等比例缩放至 1024×512 范围；Excel 每批最多 2,000 名会员。部署为单 API 实例，应用与数据库时钟需要同步。接口按北京时间日期判断状态。

设置云主机日志轮转（例如 Docker json-file 的 `max-size=10m,max-file=3`），磁盘与数据库卷剩余空间告警。不要在访问日志中记录 Cookie、Authorization、AppSecret、手机号授权凭证或完整会员资料。

## 每日备份

备份容器启动时立即备份一次，之后每天北京时间 03:00 执行 `pg_dump --format=custom`。备份先通过 `pg_restore --list` 检查，再使用 AES-256-GCM 和独立随机 nonce 加密，上传私有备份桶，并启用 COS 服务端加密。成功上传后清理同一 `BACKUP_PREFIX` 下超过 30 天的备份。

备份范围包含会员、绑定、卡片、审计、管理员哈希与导入记录。图片保存在图片桶，需在腾讯云控制台另行配置版本控制/备份策略；数据库备份不包含图片字节。备份容器临时空间为 512 MB，数据增长时按需要调整。

```sh
docker compose exec backup node /ops/backup.cjs once
docker compose exec backup cat /state/last-success.json
docker compose exec backup node /ops/backup.cjs health
docker compose logs --tail=100 backup monitor
```

监控每分钟检查 API/数据库与最近备份，状态改变时记录日志。超过 26 小时没有成功备份判为失败。`ALERT_WEBHOOK_URL` 可填写接收 `{ "text": "..." }` 的 HTTPS 告警服务地址；留空只写日志。还应在服务器之外配置 HTTPS 可用性和主机失联监控，因为本机故障时容器无法发出告警。微信服务异常会以错误码写入 API 日志；手机号资源包余额从微信公众平台检查。

## 上线前恢复演练

从 `/state/last-success.json` 取到对象 key。仅恢复到一个新的隔离数据库，示例：

```sh
docker compose exec -e RESTORE_DATABASE=gym_restore_acceptance backup node /ops/backup.cjs restore-check gym-production/实际文件名.dump.enc
```

脚本下载并认证解密、校验备份、创建独立数据库、事务恢复并查询核心表。只接受 `gym_restore_` 开头的新数据库，拒绝覆盖正式库；若目标已存在，创建失败并停止。恢复后人工抽查会员数量、有效期、绑定、审计和图片引用，再明确删除演练库。

真实事故恢复时先停止业务写入，创建新数据库并完成同样的验证，再由维护人员切换 API 数据库连接。旧数据库保持可回退；验证会员数据无误后再撤销旧会话。备份加密密钥丢失无法恢复，因此必须保留离线副本。

## 变更和回滚

发布前新建备份并验证成功，保留上一版容器镜像。前端/API 可回退至上一镜像。数据库结构升级必须新增版本迁移，先在测试数据库演练，不直接修改已运行的 001 迁移；涉及破坏性结构变更需编写对应回滚方案。

## 尚需门店环境完成的检查

当前仓库提供部署与恢复脚本。真实云服务器构建、COS 上传与保留策略、备份恢复演练、证书签发、外部告警和微信正式接口，必须在获得相关环境后执行并记录结果。
