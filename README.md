# 地下机房断电 · 离线作业手册

纯前端（TypeScript + React + Vite）的**离线优先**作业手册，**无后端、无任何在线服务**。
维护员在有网时完整下载并校验某一手册版本后，断网仍可打开页面、查阅**正确的断电步骤**、
进行**离线故障演练**。

## 核心保证

- 应用内置**三个手册版本**（`1.0.0` / `2.0.0` / `3.0.0`）。每个版本的清单含：
  - 版本号、发布时间、标题；
  - 同源资源 URL 与各自的 **SHA-256**（`manifest.json` 含**有序步骤**，`faults.json` 含故障条目）；
  - 整份资源清单的规范化 **SHA-256** 与步骤数量。
- **两种安装入口并存**：完整安装始终重新下载全部资源；“按摘要复用安装”会把当前有效版本中
  摘要完全一致的已核验字节复制到新版本暂存区，只获取变化资源；即使下载地址变化，也按摘要而非 URL 复用。
- **原子安装与切换**：一个版本的所有资源必须**全部获取/复制、逐项 SHA-256 复核，并且整份资源清单摘要通过**，
  才会写入新的“当前代际”。在此之前页面始终展示此前的完整版本。
- **退回上一版**：成功安装后最多保留当前版和紧邻的上一版。退回前必须离线复核上一版缓存中的全部资源
  与整单摘要；确认后通过一次 IndexedDB CAS 交换激活代际，使 Service Worker、步骤页和演练会话指向同一版本。
  安装进行中、上一版缺失、复核失败或确认已过期时拒绝退回，当前可用版本保持不变。
- **半包永不上线**：取消、断网、校验失败、存储配额异常，或“安装中途关闭后重开”，
  都会**清理未激活的暂存缓存**，继续展示旧版；从未成功安装时显示
  **“无可用离线包”**。
- **中断新版安装后离线刷新，仍打开旧版**；只有**完整重装并激活**后，页面才只显示新版步骤。
- **离线演练**：搜索**当前版**故障条目 → **依序勾选**动作 → 得到**与版本绑定的通过结论**；
  切换或退回版本会终止未完成演练，并使旧版本的通过结论失效。
- **可选“锁定本次演练版本”**：开始演练时可把当前代际（版本 + 安装代次 + 故障条目）固定到演练会话。
  锁定后**允许随后成功安装一版新手册**——普通步骤页切到新版，而该演练的资源读取、动作次序与
  通过记录始终指向锁定版缓存（Service Worker 按锁定代际提供，离线可读）。安装器、IndexedDB 指针与
  缓存回收共同保证锁定缓存不被删除：**在锁定演练结束前，若再次安装或退回需要第三份手册缓存，
  一律明确拒绝（`locked`），绝不删除正在使用的资源**。刷新后恢复会话与版本绑定（含勾选进度与通过记录），
  **完成或取消才释放锁定**；下载、校验或持久化失败均不产生混合版本。未选择锁定时，沿用现有
  “切版即终止演练”的语义。
- 离线读取由 **Service Worker + Cache Storage** 负责；
  **IndexedDB 只保存当前/上一版代际指针、安装状态与锁定演练绑定一条记录**，不存手册正文。
- 浏览器缺少 Service Worker / Cache Storage / IndexedDB / Web Crypto 等能力时，页面显示
  **`UNSUPPORTED`**，不降级、不提供占位实现。

## 目录结构

```
public/manuals/v1|v2|v3/      三个内置版本的同源资源（有序步骤 + 故障条目）
scripts/generate-catalog.mjs 扫描资源并计算单项与整单 SHA-256，生成 src/manuals/catalog.json
src/core/                    纯逻辑（无 DOM 依赖）
  installer.ts               安装协调器（完整/复用获取→暂存复核→原子提交；失败/中断清理；复核后退回上一版）
  generation.ts              安装代次与缓存键名规则（页面、SW 共享）
  resource-digest.ts         整份资源清单的规范化摘要
  drill.ts                   演练：搜索、依序勾选、版本绑定结论、切版终止
  idb.ts                     IndexedDB 仅存“当前代际 + 安装状态 + 锁定演练绑定”
src/service-worker/          SW：手册从当前激活代际缓存读取；锁定演练请求按 x-manual-drill-cache 固定读锁定代际
src/platform/                浏览器端口（Cache/fetch/WebCrypto）、能力检测、SW 注册
src/components/              React UI（安装管理、步骤、离线演练、锁定版本开关）
src/test/fault-injection.ts  仅用于端到端的 SW 故障注入（无规则时完全透传，不影响生产）
plugins/sw-build.ts          构建期用 esbuild 编译 SW 并注入应用壳预缓存清单
e2e/                         Playwright：中断安装、离线重载、演练、首次失败、锁定演练、UNSUPPORTED
```

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173（开发模式 SW 网络优先，支持 HMR）
```

## 构建与测试

```bash
npm run build      # 生成目录 + tsc 类型检查 + Vite 生产构建（含 SW 与预缓存清单）
npm run preview    # 本地静态预览（默认 http://localhost:4173）

npm run test       # Vitest：完整/摘要复用、取消/断网/校验/配额/中断重开/迟到代次/升级回收/退回边界/锁定演练
npm run e2e        # Playwright：复用安装、中断安装与离线重载、离线演练、断网退回、跨标签交错、首次失败、锁定演练、UNSUPPORTED
npm run verify     # 类型检查 + 单测 + 构建 + Playwright，一键全量验收
```

> Service Worker 需要安全上下文：`https` 或 `localhost`。生产请用 `https` 或经 `localhost`
> 访问；非安全上下文会显示 `UNSUPPORTED`。

## Docker Compose

以 Nginx 纯静态托管，宿主端口可用 **`WEB_PORT`** 覆盖（默认 `8080`）：

```bash
docker compose up -d --build web          # http://localhost:8080
WEB_PORT=9000 docker compose up -d web    # http://localhost:9000
```

一次性**验收服务**（类型检查 → 单测 → 构建 → Playwright，跑完即退出，退出码即结论）：

```bash
docker compose up --build verify
```

`verify` 通过内网 `http://web` 访问已健康检查通过的 `web` 容器，不占用宿主端口。

## 清除缓存的方法

本应用的离线数据分三处，用途不同；排查问题或重置时按下表清理。

### 1. 浏览器 DevTools（推荐）

1. 打开页面 → F12 → **Application** 面板。
2. **Storage** → 点击 **Clear site data**（会同时清掉下面三类）。
3. 或分别清理：
   - **Service Workers** → 对本站点 **Unregister**；
   - **Cache Storage** → 删除 `shell:*`（应用壳）与所有 `manual:*`（手册代际/暂存）；
   - **IndexedDB** → 删除 `manual-kiosk-db`（仅含当前/上一版代际指针、安装状态与锁定演练绑定）。
4. **硬刷新**：Windows/Linux `Ctrl+Shift+R`，macOS `Cmd+Shift+R`。

### 2. 命令行（无头 / 自动化环境）

在站点页面上下文执行：

```js
(async () => {
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));     // 注销 SW
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));  // 清空 Cache Storage
  indexedDB.deleteDatabase('manual-kiosk-db');           // 删除代际状态
  location.reload();
})();
```

### 3. Docker 场景

```bash
docker compose down -v        # 停止并移除卷；镜像侧无状态，重建即获得全新产物
docker compose up -d --build web
```

> 缓存命名约定：`shell:<sw-version>` 为应用壳；`manual:stage:<version>:<install-id>`
> 为某次安装的暂存缓存。**手册请求只会命中 IndexedDB 当前指针与安装 ID 同时匹配的那一个缓存**，
> 任何暂存/半包或迟到代次缓存对外都不可见，因此清缓存或异常中断都不会让半包顶替旧手册。
> 新代际缓存复制了自己所需的全部字节；成功安装后最多保留当前版与紧邻上一版两个手册缓存，
> Service Worker 只读取当前激活指针，退回时一次性交换当前/上一版指针。
> **锁定演练期间**，锁定代际缓存即使既不是当前版也（在一次安装后）成为“上一版”，也会被显式保留：
> 普通读取走当前激活指针，演练请求携带 `x-manual-drill-cache` 头由 SW 校验后只从锁定缓存出
> （未命中直接失败，绝不回退网络/激活缓存）；需要第三份缓存的安装/退回在协调器与 IDB CAS 两层被拒绝。

## 安装状态机（速查）

```
idle ──完整安装/摘要复用──▶ installing ──全部资源与整单摘要复核通过──▶ activated（CAS 提交新代际→保留当前与紧邻上一版）
                       │
                       ├─ 复用：当前版同摘要字节复制到新暂存区；变化资源正常获取
                       ├─ 取消 / abort / 迟到代次 ─▶ failed(canceled) ─┐
                       ├─ 断网 / 非 2xx ───────────▶ failed(network)  ─┤ 清理本次暂存缓存
                       ├─ 单项/暂存/整单摘要不符 ──▶ failed(checksum) ─┤ 已激活版本不受影响
                       └─ 容量预估/写入配额异常 ───▶ failed(quota)    ─┘
（安装中途进程被杀 → IDB 留下 pending → 下次启动 init() 清理半包并恢复旧版）

idle ──复核上一版──▶ rollback-reviewing ──确认──▶ rolled-back（一次 CAS 交换当前/上一版，两缓存均保留）
          │                   │
          ├─ 安装中 ─▶ failed(busy)    ├─ 另一标签已切换 ─▶ failed(stale)
          ├─ 缓存缺失 ─▶ failed(missing)
          └─ 资源/整单摘要失败 ─▶ failed(checksum)
（任何退回失败都不清理当前版或上一版缓存，当前可用版本继续可读）

锁定演练（可选，默认不勾选）：
idle ──勾选“锁定本次演练版本”并开始──▶ drill-locked（IDB 固定 version/cacheName/generation/条目）
        │
        ├─ 安装另一版本（仅当尚无“上一版”）─▶ activated：普通指针切新版，锁定缓存成为上一版且继续保留，绑定不变
        │      └─ 此后再装任意版本 / 退回 ─▶ failed(locked)：明确拒绝，不创建第三份缓存、不删除锁定资源
        ├─ 勾选动作/通过结论 ─▶ 每步持久化到 IDB（刷新后恢复进度、条目与通过记录）
        ├─ 刷新/重开 ─▶ 从 IDB 恢复会话与版本绑定；锁定缓存缺失才释放绑定
        └─ 完成或取消 ─▶ drillLock 清空，恢复“最多当前+上一版”的正常安装/回收语义
（未选择锁定时：切换或退回版本即终止未完成演练，旧结论失效——与既有语义一致）
```
