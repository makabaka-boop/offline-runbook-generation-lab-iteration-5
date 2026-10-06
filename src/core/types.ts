/** 手册手册域的共享类型定义（无 DOM 依赖，可在 SW 与测试中使用）。 */

/** 清单中单个同源资源的引用：URL + SHA-256 完整性。 */
export interface ResourceRef {
  url: string;
  sha256: string;
  kind: 'manual' | 'faults';
}

/** 手册版本清单（含版本号、同源资源、有序步骤与故障条目）。 */
export interface ManualManifest {
  version: string;
  releasedAt: string;
  title: string;
  steps: OrderedStep[];
}

export interface OrderedStep {
  order: number;
  action: string;
  detail: string;
}

export interface FaultEntry {
  id: string;
  title: string;
  keywords: string[];
  symptoms: string;
  actions: string[];
}

/** 内置手册目录中的一个版本条目（清单：版本号 + 同源 URL + SHA-256 + 有序步骤数）。 */
export interface CatalogEntry {
  version: string;
  releasedAt: string;
  title: string;
  stepCount: number;
  resources: ResourceRef[];
  /** 对整份资源清单（URL、摘要、类型及顺序）的 SHA-256，防止单项之外的清单结构被替换。 */
  resourcesSha256: string;
}

/** 安装失败原因分类。 */
export type FailureCode =
  | 'checksum' // 校验失败
  | 'network' // 断网 / 下载失败
  | 'quota' // 配额异常
  | 'canceled' // 取消 / 过期安装代次
  | 'busy' // 安装仍在进行，不能退回
  | 'missing' // 上一版缓存或元数据缺失
  | 'stale' // 退回确认迟到，激活代际已被其他标签页切换
  | 'locked' // 锁定演练仍在进行：再装/退回需要第三份手册缓存
  | 'unknown';

export const FAILURE_TEXT: Record<FailureCode, string> = {
  checksum: '资源校验失败（SHA-256 不匹配）',
  network: '下载中断或网络不可用，已丢弃本版缓存',
  quota: '存储空间配额异常，已丢弃本版缓存',
  canceled: '安装已取消，未激活缓存已清理',
  busy: '安装仍在进行，不能退回版本；当前可用版本保持不变',
  missing: '上一版完整缓存缺失，不能退回；当前可用版本保持不变',
  stale: '退回确认已过期：另一标签页已完成切换，未覆盖新代际',
  locked:
    '锁定演练仍在进行：该操作需要第三份手册缓存，已拒绝（不会删除演练正在使用的版本）',
  unknown: '发生未知错误',
};

export type InstallMode = 'full' | 'reuse';

/** IndexedDB 中唯一持久化的记录（当前/上一版代际指针与安装状态）。 */
export interface PersistedState {
  /** 当前已激活的完整版本；从未成功安装时为 null。 */
  activeVersion: string | null;
  /** 已激活版本缓存的 Cache Storage 键名。 */
  activeCacheName: string | null;
  /** 已激活代次的唯一安装 ID；缓存名也必须携带同一 ID。 */
  activeGeneration: string | null;
  /**
   * 紧邻当前版、且缓存仍完整保留的上一版。
   * 成功安装新代际后写入；退回成功后与当前版交换。只有当前版的存量记录为 null。
   */
  previousVersion: string | null;
  previousCacheName: string | null;
  previousGeneration: string | null;
  /**
   * 正在进行中的安装（用于关闭后重开时识别“半包”）。
   * 一旦存在即视为中断残留，启动时清理并永不激活。
   */
  pending: {
    version: string;
    cacheName: string;
    installId: string;
    mode: InstallMode;
    startedAt: number;
  } | null;
  /**
   * 锁定演练会话（可选）：开始演练时把“当前代际 + 版本 + 故障条目”固定到演练会话。
   * 锁定期间允许安装新版（普通步骤页切到新版），但该演练的资源读取、动作次序与通过记录
   * 始终指向锁定缓存；再次安装/退回若需要第三份手册缓存则被明确拒绝。
   * 完成或取消演练才释放；刷新后从 IDB 恢复同一份绑定（含动作进度与通过记录）。
   */
  drillLock: DrillLock | null;
}

/** 锁定演练的通过记录快照（不含手册正文：标题在恢复时由锁定版条目按 entryId 还原）。 */
export interface DrillPassSnapshot {
  version: string;
  entryId: string;
  totalActions: number;
  passedAt: number;
  code: string;
}

/** 锁定演练会话与某一已核验代际缓存的绑定，同时承载刷新后可恢复的演练进度。 */
export interface DrillLock {
  /** 会话标识（同一次刷新恢复保持不变；完成/取消后新会话使用新 ID）。 */
  sessionId: string;
  version: string;
  cacheName: string;
  generation: string;
  /** 锁定会话固定的故障条目 ID；资源读取与动作次序均以锁定版的该条目为准。 */
  faultId: string;
  /** 已依序勾选到第几步（0..actions.length）。 */
  checkedUpTo: number;
  /** 是否已通过；通过后会话停留在此状态，直到用户完成释放。 */
  passed: boolean;
  /** 本会话产生的、与锁定版绑定的通过记录（刷新后恢复）。 */
  records: DrillPassSnapshot[];
  startedAt: number;
}

export const INITIAL_PERSISTED_STATE: PersistedState = {
  activeVersion: null,
  activeCacheName: null,
  activeGeneration: null,
  previousVersion: null,
  previousCacheName: null,
  previousGeneration: null,
  pending: null,
  drillLock: null,
};

export interface RollbackReview {
  version: string;
  cacheName: string;
  generation: string;
  resourceCount: number;
  resourcesSha256: string;
}

export type InstallerStatus =
  | { kind: 'idle' }
  | {
      kind: 'installing';
      installId: string;
      mode: InstallMode;
      version: string;
      phase: 'acquire' | 'verify';
      /** 0–100 的整数进度。 */
      progress: number;
      completed: number;
      total: number;
      reused: number;
      fetched: number;
      verified: number;
      cancelRequested: boolean;
    }
  | { kind: 'activated'; installId: string; version: string }
  | { kind: 'rollback-reviewing'; review: RollbackReview }
  | { kind: 'rolled-back'; version: string; fromVersion: string; generation: string }
  | {
      kind: 'failed';
      installId?: string;
      version: string | null;
      code: FailureCode;
      scope?: 'install' | 'rollback' | 'drill';
    };

export interface Snapshot {
  activeVersion: string | null;
  activeGeneration: string | null;
  previousVersion: string | null;
  previousGeneration: string | null;
  /** 进行中的锁定演练绑定；无锁定演练时为 null。 */
  drillLock: DrillLock | null;
  status: InstallerStatus;
}
