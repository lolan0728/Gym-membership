# 接口与数据约定

所有接口以 `/api` 开头。请求与响应使用 JSON，图片/Excel 上传使用单文件 multipart，字段名 `file`。错误返回 `{statusCode,message,requestId}`。400 为输入错误，401 需重新登录，403 权限/身份不满足，409 为重复或并发冲突，429 为频次限制，503 为上游服务不可用。

## 身份

后台：`POST /admin/login {password}` 设置 HttpOnly 会话 Cookie。所有后台写操作要求 `Origin=ADMIN_ORIGIN` 且 `X-Gym-Request: 1`。生产 Cookie 为 Secure/SameSite=Strict；会话最长 12 小时。会话令牌只存 SHA-256 哈希。密码使用带独立随机盐的 scrypt。

微信：`POST /wechat/login {code}` 将 wx.login 凭证交由微信验证，返回 `{token,bound}`。后续使用 `Authorization: Bearer <token>`，最长 30 天。`openid`、AppSecret 和 session_key 不下发。登录失效后重新执行 wx.login，绑定关系仍然保留。

`POST /wechat/bind {phoneCode}` 接收 getRealtimePhoneNumber 组件动态令牌，由服务端向微信换取号码。仅绑定已经录入的会员，不接受前端直接传手机号。已绑定身份重复提交返回当前绑定成功，不切换会员。两个不同微信同时领取同一会员，仅一个成功。重置绑定删除关联身份的全部会话。

## 接口清单

| 方法与路径 | 用途 |
|---|---|
| GET /health | 数据库与服务存活检查 |
| GET /store、/store/logo | 门店公开名称、电话与 Logo |
| GET /me | 本人姓名、卡号、模板、头像标识、当前卡 `card` 和 `cardHistory`；不返回手机号、内部备注、备注和审计 |
| PUT /me/theme | `{theme:gold/blue/orange/white}`；微信网络接口使用 PUT |
| POST /me/avatar、GET /me/avatar | 上传/读取本人头像；私有头像需会话，不能指定其他会员 |
| GET /admin/session、POST /admin/logout | 当前管理员/注销 |
| POST /admin/password | `{current,next}`；新密码至少 8 位、可使用纯数字，撤销全部管理员会话 |
| GET /admin/stats | 总会员、当前有效、即将到期、未绑定数；年卡提前 30 天、月卡提前 7 天 |
| GET /admin/members | search/status/endFrom/endTo/expiring/page/pageSize，默认 10 条，最大 100 条；不支持卡种筛选 |
| POST /admin/members | `{name,phone,note?,kind,startDate,endDate,cardRemark?}`；系统生成卡号，新增档案与初始卡片同一事务 |
| GET /admin/members/:id | 档案、当前卡 `card` 和含备注的 `cardHistory`；不返回底层审计日志 |
| PATCH /admin/members/:id | `{name,phone,note,version}`；防止旧页面覆盖 |
| POST /admin/members/:id/card/renew | `{kind,startDate,endDate,remark?,version}`；延长或重新启用当前卡 |
| PATCH /admin/members/:id/card | `{kind,startDate,endDate,remark?,version}`；更正当前未作废卡片 |
| POST /admin/members/:id/card/void | `{reason}`；作废当前卡并保留历史 |
| POST /admin/members/:id/reset-binding | `{reason}`；核实后解绑并撤销旧会话 |
| GET /admin/imports/template | Excel 模板 |
| POST /admin/imports/preview | 上传，返回批次 ID、rows、errors、ready/invalid/committed |
| POST /admin/imports/:id/confirm | 锁定批次并整批事务导入；已提交幂等返回 |
| GET /admin/imports | 最近 30 个批次 |
| GET/PATCH /admin/settings | `{name,phone}` |
| POST /admin/settings/logo | 上传门店 Logo |
| GET /admin/qrcode | 微信官方生成的统一门店小程序码 |

## 数据约束

- 会员 UUID 作为内部 ID，手机号和卡号独立唯一。微信绑定表同时约束 openid 和 member_id 唯一。
- 卡种只有 year/month。每名会员在 `memberships` 中只有一张当前卡；开卡、续卡、修改和作废快照保存在 `membership_events`。使用 PostgreSQL DATE 保存开始和到期日，并按 Asia/Shanghai 日期判断状态，有效期包含两端。
- 续卡按 30/365 天预填。未到期卡保持开始日期并延长到期日；年卡续月卡仍显示年卡，月卡续年卡升级为年卡。已到期或作废卡按本次选择重新确定卡种。
- 新开卡或重新开卡时，到期日偏离开始日加 30/365 天必须填写备注；未到期续卡时，到期日偏离原到期日加 30/365 天必须填写备注。修改已保存的开始日期或到期日期必须填写备注。备注去除首尾空格，最长 500 字。
- `membership_events.remark` 保存每次备注并只向管理员返回。创建/续卡/作废/修改/绑定/重置/导入仍写入 `audit_logs`，与业务变更同一事务提交，但会员详情页面不展示底层审计。修改档案和卡片使用版本号避免覆盖。
- `expiring=true` 只匹配当前有效卡：年卡到期日不晚于今天加 30 天，月卡不晚于今天加 7 天。到期当天包含在内。
- Excel 模板列为“姓名、手机号、卡种、开始日期、到期日期、备注、会员档案备注”。期限偏离 30/365 天时备注必填。文件 SHA-256 标识相同文件，批次确认行锁防止重复执行；预览不是写入授权的替代，确认阶段仍受数据库唯一约束。
- 图片验证实际内容、大小与像素并移除原始元数据。头像裁剪为最大 512×512 JPEG；门店 Logo 按原比例缩放到 1024×512 范围内并保存为 PNG。新图片保存和记录更新成功后才清理旧图片；对象存储私有读取经 API 鉴权。

## 迁移与扩展

版本化迁移在 API 启动时按编号执行，PostgreSQL 使用 advisory lock 和 schema_migrations 保证只执行一次。已有迁移文件不可改写；后续结构或默认数据变更新增版本。002 只把旧占位名称和演示名称更新为“悦体健身”，不会覆盖已经自定义的门店名称。`.local-data` 是本地开发数据，不能直接作为正式 PostgreSQL 数据目录挂载。
