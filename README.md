# 餐厅后厨出餐与过敏原核验后端

TypeScript + Node.js + SQLite(内置 `node:sqlite`,零原生依赖)的本地后端:菜单版本、菜品配方、过敏原、餐桌订单、加料与替换、厨师工位、制作票、出餐批次与退菜原因,并持久化每次订单修改与制作状态。仅提供 API、CLI、本地夹具与自动化测试——不含网页、支付或真实点餐平台对接。所有数据均为虚构。

## 环境要求

- Node.js >= 22.5(开发环境为 Node 25)
- 无运行时第三方依赖(仅 devDependencies: typescript / tsx)

## 安装与测试

```bash
npm install
npm test          # node:test 全套测试(内存库 + 临时文件库,时钟/ID 可注入)
npm run typecheck
```

## 启动与停止

```bash
npm run seed                 # 初始化 ./restaurant.db 并写入虚构夹具数据
PORT=8787 npm start          # 启动 API;PORT 缺省为 0 时自动分配本机空闲端口
# 停止:Ctrl+C(SIGINT/SIGTERM 优雅关闭并落盘)
```

## 端到端演示(可重复运行)

```bash
npm run demo    # 临时库 + 自动端口,演示过敏原阻断/依赖出餐/幂等/改票,结束后自动清理
```

CLI 演示(先 `npm start`,再另开终端):

```bash
$env:API_BASE="http://127.0.0.1:8787"
npx tsx src/cli/main.ts menu:list
npx tsx src/cli/main.ts order:create 1 2 1 "1:2:rush" --key demo-1
npx tsx src/cli/main.ts queue hot
npx tsx src/cli/main.ts ticket:start 1
npx tsx src/cli/main.ts ticket:complete 1 1 hot serve-key-1
npx tsx src/cli/main.ts item:return 1 1 "太辣" restock
npx tsx src/cli/main.ts order:show 1
```

关键操作(`item:modify`、`ticket:complete`)会直接打印处理前后状态。

## API 概览

统一响应:成功 `{ ok: true, ... }`;失败 `{ ok: false, error: { code, message, details? } }`。
列表接口支持 `?limit=&offset=`(limit ≤ 100)。写操作支持 `Idempotency-Key` 请求头。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/menus` `/menus/:id/dishes` `/menus/:id/activate` | 菜单版本管理(激活时归档旧版本) |
| GET | `/menus` | 分页查询 |
| POST | `/orders` | 下单:校验菜单版本有效、过敏原、库存,同事务占料并分工位出票 |
| GET | `/orders` `/orders/:id` | 分页/详情(含事件流水) |
| POST | `/items/:id/mods` | 加料/替换/去料;已开工菜品作废原票并生成替代票,绝不覆盖原票 |
| POST | `/items/:id/cancel` `/rush` `/return` | 部分撤单(释放占料)、加急、退菜(可选回库) |
| POST | `/tickets/:id/start` | 开工;校验依赖票已完工 |
| POST | `/tickets/:id/complete` | 完工/部分出餐;幂等键防重复扣料 |
| POST | `/tickets/:id/redo` | 重做:重新扣料并生成 redo 票 |
| GET | `/stations/:code/queue` | 工位队列(加急优先,其次 FIFO) |

错误码:`BAD_REQUEST`、`NOT_FOUND`、`ALLERGEN_CONFLICT`(details 含具体过敏原与来源配料)、`INSUFFICIENT_STOCK`、`MENU_NOT_ACTIVE`、`DEPENDENCY_NOT_MET`、`INVALID_STATE`。

## 设计要点

- **库存守恒**:下单占料(reserve)→ 出餐消耗(consume)→ 撤单释放(release)→ 退菜回库(restock);`inventory_moves` 台账可全量对账,测试验证 `Σmoves == 库存净变化`。
- **幂等**:订单、出餐批次均有唯一幂等键;重复请求返回原结果,绝不重复扣料。
- **事务与并发**:多步写入包裹在 `BEGIN IMMEDIATE` 事务中;WAL + busy_timeout;进程中断时未提交事务自动回滚,重启后迁移幂等重放、状态完整恢复。
- **过敏原**:按"有效配方"(基础配方 + 加料/替换/去料)对食客过敏源核验;替换配料后仍重新核验,无法绕过;冲突即整单拒绝并列出具体来源。
- **可测试性**:时钟与 ID 生成器可注入;测试不依赖真实等待或时序。
- **数据**:全部为虚构中餐厅数据;服务默认绑定 `127.0.0.1` 且端口可自动分配。

## 目录结构

```
src/db/        连接、迁移(可重复执行)、事务助手
src/domain/    菜单、订单、厨房(票据/出餐/退菜)、配方与库存、错误码
src/api/       HTTP 层(参数校验、分页、统一错误)
src/cli/       命令行
fixtures/      虚构夹具(多桌、两版菜单同菜不同配方、过敏食客)
scripts/       端到端演示
test/          node:test 测试(守恒/幂等/并发/重启恢复/API 失败路径)
```
