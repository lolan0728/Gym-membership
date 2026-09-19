# 悦体健身 JOYFIT 会员管理系统

当前开发分支提供 Windows 单机版。便携版 ZIP 位于 `output/windows`，无需安装，也无需云服务器、域名、Docker、PostgreSQL或单独安装Node.js。会员数据保存在当前Windows用户的本地应用数据目录，每日导出Excel并可通过QQ邮箱发送。

## Windows 单机版

```powershell
npm ci
npm run build:portable
```

首次构建还需要 Rust stable 和 Visual Studio 2022 Build Tools（Desktop development with C++）。生成的便携版 ZIP 在 `output/windows`；完整解压后双击主程序即可使用。

安装后首次启动需设置管理员密码、门店信息、月卡/年卡天数和备份邮箱。月卡默认30天，年卡默认365天，修改只影响后续新办和续卡。会员头像、微信绑定和小程序功能不在单机版中启用。

详细操作见 [Windows单机版使用与备份说明](docs/desktop-guide.md)。

## 保留的微信版源码

微信原生小程序、Vue 3 管理后台、NestJS API、PostgreSQL、COS 图片存储与 Docker 部署。会员仅领取已有档案，不自行注册或付款。

### 开发环境启动

需要 Node.js 22.12+（推荐 24）。在项目根目录执行：

```powershell
npm ci
npm run setup:local
npm run seed:demo
npm run dev
```

打开 **http://localhost:15173**。随机生成的初始密码保存在根目录 `.local-credentials.txt`，不会写入源码。`seed:demo` 可选，仅向空的本地数据库录入 12 位标明用途的演示会员，不对正式数据库运行。

本地使用 PGlite（嵌入式 PostgreSQL）和本地图片目录，数据保存在 `.local-data`。正式环境强制使用 PostgreSQL 和私有 COS 存储。本地仍需真实微信账号才能测试领取与绑定，不存在模拟手机号登录入口。

`.env` 是私密配置，不要提交。请固定使用 `localhost:15173`，避免切换为 `127.0.0.1:15173` 导致后台来源校验不匹配。服务监听本机地址。

## 验证

```powershell
npm run build
npm test
# 自动启动隔离的 API 和前端端口；默认使用已安装的 Chrome
npm run test:ui
```

`npm run build` 编译 API、构建管理页面并检查小程序 TypeScript。`npm test` 使用隔离内存 PostgreSQL，验证权限、并发冲突、日期边界、导入事务、头像、Logo 和备份加密。测试内替换微信服务，不代表已通过真实微信接口验收。`test:ui` 会自行启动随机本地端口，并在本地演示库中修改和恢复一条备注，留下正常审计记录；仅用于开发环境。

## 项目结构

| 目录 | 内容 |
|---|---|
| `apps/api` | NestJS API、数据库迁移、自动化测试 |
| `apps/admin` | 管理员后台 |
| `apps/miniprogram` | 微信原生小程序，导入微信开发者工具打开 |
| `ops` | HTTPS、生产环境变量、加密备份、恢复演练和监控 |
| `docs` | 操作说明、接口说明、上线及验收清单 |

## 继续阅读

- [管理员操作说明](docs/owner-guide.md)
- [部署、备份与恢复](docs/deployment.md)
- [微信接入与真机验收](docs/wechat-release.md)
- [接口与数据规则](docs/api.md)
- [当前验证记录](docs/verification.md)

微信注册认证、备案、正式域名、云资源和手机设备需要门店提供。仓库不包含真实密钥，不会自动开通付费服务或发布小程序。
