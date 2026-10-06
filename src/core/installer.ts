/**
 * 安装状态协调器（框架无关的纯核心，Vitest 直接覆盖）。
 *
 * 不变量：
 * 1. 一个版本的所有资源“全部获得 + 逐项 SHA-256 + 整单摘要校验通过”后，才提交新的激活代际。
 * 2. 半包（pending）在任何路径下都不会被激活；取消、断网、校验失败、配额异常
 *    以及安装中关闭后重开，都只清理该未激活缓存。
 * 3. 已激活的完整版本在失败/中断期间继续保留并可读；从无成功安装则 activeVersion=null，
 *    界面显示“无可用离线包”。
 * 4. IndexedDB 的代际切换先于缓存回收（崩溃也只会留下孤儿缓存，下次启动回收）。
 * 5. 摘要复用只从当前激活代际复制字节到新暂存区；新代际激活后拥有独立缓存，成功后最多保留当前与紧邻上一版。
 * 6. 退回只在复核上一版全部资源与整单摘要后执行一次 CAS 指针交换；失败时不清理任一已激活缓存。
 * 7. 锁定演练把会话固定到锁定代际缓存：允许随后安装一版新手册（普通页切新版、锁定演练继续读锁定缓存）；
 *    在锁定释放前，任何需要第三份手册缓存的再次安装/退回一律拒绝（'locked'），绝不删除正在使用的资源。
 */
import type {
  CatalogEntry,
  DrillLock,
  FailureCode,
  InstallMode,
  PersistedState,
  ResourceRef,
  RollbackReview,
  Snapshot,
} from './types';
import { INITIAL_PERSISTED_STATE } from './types';
import { encodeCanonicalResourceList } from './resource-digest';
import {
  cacheNameMatchesGeneration,
  installGenerationFromCacheName,
  stageCacheNameFor,
  type InstallGeneration,
} from './generation';

export class HttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}
export class ChecksumError extends Error {
  constructor(public readonly url: string) {
    super(`校验失败: ${url}`);
    this.name = 'ChecksumError';
  }
}
export class QuotaError extends Error {
  constructor() {
    super('配额不足');
    this.name = 'QuotaError';
  }
}
export class Canceled extends Error {
  constructor() {
    super('已取消');
    this.name = 'Canceled';
  }
}
export class StaleGenerationError extends Error {
  constructor() {
    super('安装代次已过期');
    this.name = 'StaleGenerationError';
  }
}
export class RollbackBusyError extends Error {
  constructor() {
    super('安装仍在进行，不能退回');
    this.name = 'RollbackBusyError';
  }
}
export class RollbackMissingError extends Error {
  constructor() {
    super('上一版完整缓存缺失');
    this.name = 'RollbackMissingError';
  }
}
export class StaleRollbackError extends Error {
  constructor() {
    super('退回确认已过期');
    this.name = 'StaleRollbackError';
  }
}
export class LockedDrillError extends Error {
  constructor(message = '锁定演练仍在进行，操作需要第三份手册缓存') {
    super(message);
    this.name = 'LockedDrillError';
  }
}

export interface StagedResource {
  bytes: Uint8Array;
  contentType: string;
}

/** 平台端口：浏览器实现由 src/platform 提供，测试用内存假实现。 */
export interface InstallerPorts {
  loadState(): Promise<PersistedState>;
  saveState(state: PersistedState): Promise<void>;
  /** 仅当 IDB 中的 pending 仍属于 expectedGeneration 时提交激活状态。 */
  commitStateIfPending(
    state: PersistedState,
    expectedGeneration: string,
  ): Promise<boolean>;
  /** 仅当当前/上一版指针与复核时完全一致且无安装进行时，原子交换两代际。 */
  commitRollbackIfActive(
    state: PersistedState,
    expected: {
      activeVersion: string;
      activeGeneration: string;
      activeCacheName: string;
      previousVersion: string;
      previousGeneration: string;
      previousCacheName: string;
    },
  ): Promise<boolean>;
  /** 下载单个资源；AbortSignal 触发时应拒绝 AbortError/Canceled。 */
  fetchResource(
    ref: ResourceRef,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  sha256(bytes: Uint8Array): Promise<string>;
  /** 在复制前估算可用容量；无法查询时允许返回 null（由写入时配额错误兜底）。 */
  estimateAvailableCapacity(): Promise<number | null>;
  openCache(name: string): Promise<ManualCacheLike>;
  readCacheEntry(cacheName: string, ref: ResourceRef): Promise<StagedResource | null>;
  deleteCache(name: string): Promise<boolean>;
  /** 指定缓存是否仍存在（用于刷新后确认锁定演练绑定的缓存未被手动清除）。 */
  cacheExists(name: string): Promise<boolean>;
  /** 列出当前所有代际缓存键名（前缀 manual:）。 */
  listManualCaches(): Promise<string[]>;
  now(): number;
}

export interface ManualCacheLike {
  get(url: string): Promise<StagedResource | null>;
  put(url: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** 每次安装尝试使用唯一暂存缓存名；只有提交后代际指针才指向它。 */
export { stageCacheNameFor };

type Listener = (snapshot: Snapshot) => void;

const toFailureCode = (err: unknown): FailureCode => {
  if (err instanceof ChecksumError) return 'checksum';
  if (err instanceof Canceled || err instanceof StaleGenerationError) return 'canceled';
  if (err instanceof RollbackBusyError) return 'busy';
  if (err instanceof RollbackMissingError) return 'missing';
  if (err instanceof StaleRollbackError) return 'stale';
  if (err instanceof LockedDrillError) return 'locked';
  if (err instanceof QuotaError) return 'quota';
  if (err instanceof HttpError) return 'network';
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'AbortError' || name === 'Canceled' || name === 'StaleGenerationError') {
      return 'canceled';
    }
    if (name === 'RollbackBusyError') return 'busy';
    if (name === 'RollbackMissingError') return 'missing';
    if (name === 'StaleRollbackError') return 'stale';
    if (name === 'LockedDrillError') return 'locked';
    if (
      name === 'QuotaExceededError' ||
      /quota|exceeded/i.test(err.message)
    ) {
      return 'quota';
    }
    if (name === 'TypeError' || name === 'NetworkError') return 'network';
  }
  return 'unknown';
};

const normalizeHash = (hex: string) => hex.trim().toLowerCase().replace(/^sha256-/, '');

export interface InstallOptions {
  mode?: InstallMode;
  /** 当前激活版本的目录条目；复用模式按其中资源摘要从激活缓存定位字节。 */
  activeEntry?: CatalogEntry | null;
}

interface InstallAttempt {
  generation: InstallGeneration;
  cacheName: string;
  mode: InstallMode;
  controller: AbortController;
}

export class InstallerCoordinator {
  private state: PersistedState = { ...INITIAL_PERSISTED_STATE };
  private snapshot: Snapshot = {
    activeVersion: null,
    activeGeneration: null,
    previousVersion: null,
    previousGeneration: null,
    drillLock: null,
    status: { kind: 'idle' },
  };
  private current: InstallAttempt | null = null;
  private rollbackReview: (RollbackReview & { fromVersion: string; fromGeneration: string }) | null = null;
  private rollbackEntry: CatalogEntry | null = null;
  private generationChannel: BroadcastChannel | null = null;
  /** 当前安装尝试使用的激活版本目录条目；仅按其中资源摘要定位旧版字节。 */
  private activeCatalogEntry: CatalogEntry | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;

  constructor(private readonly ports: InstallerPorts) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): Snapshot {
    return this.snapshot;
  }

  private snapshotFrom(status: Snapshot['status']): Snapshot {
    return {
      activeVersion: this.state.activeVersion,
      activeGeneration: this.state.activeGeneration,
      previousVersion: this.state.previousVersion,
      previousGeneration: this.state.previousGeneration,
      drillLock: this.state.drillLock,
      status,
    };
  }

  private emit() {
    this.snapshot = this.snapshotFrom(this.snapshot.status);
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private setStatus(status: Snapshot['status']) {
    this.snapshot = this.snapshotFrom(status);
    this.emit();
  }

  /**
   * 启动恢复：若存在 pending 半包（含“安装中关闭后重开”），丢弃其缓存与状态，
   * 继续展示此前的完整版本；若无完整版本则界面显示“无可用离线包”。
   * 同时回收任何不属于当前激活代际的孤儿缓存。
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initOnce();
    return this.initPromise;
  }

  private clearRollbackReview() {
    this.rollbackReview = null;
    this.rollbackEntry = null;
  }

  private async initOnce(): Promise<void> {
    const state = await this.ports.loadState();
    if (state.pending) {
      await this.safeDelete(state.pending.cacheName);
      state.pending = null;
      await this.ports.saveState(state);
    }
    // 刷新恢复：锁定缓存若已不在 Cache Storage（如用户在 DevTools 手动删除），
    // 锁定无法继续，显式释放绑定而不是让会话指向不存在的资源。
    if (state.drillLock) {
      const present = await this.ports.cacheExists(state.drillLock.cacheName);
      if (!present) {
        state.drillLock = null;
        await this.ports.saveState(state);
      }
    }
    this.state = state;
    this.clearRollbackReview();
    await this.reconcileCaches();
    this.snapshot = this.snapshotFrom({ kind: 'idle' });
    this.emit();
  }

  private async reconcileCaches() {
    const keep = new Set(
      [
        this.state.activeCacheName,
        this.state.previousCacheName,
        this.state.drillLock?.cacheName,
      ].filter((name): name is string => Boolean(name)),
    );
    let names: string[] = [];
    try {
      names = await this.ports.listManualCaches();
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => !keep.has(name) && name.startsWith('manual:'))
        .map((name) => this.safeDelete(name)),
    );
  }

  private async safeDelete(name: string) {
    try {
      await this.ports.deleteCache(name);
    } catch {
      // 删除失败不改变状态正确性：该缓存既不在 IDB 中被引用，后续仍会被回收。
    }
  }

  private assertCurrent(attempt: InstallAttempt) {
    if (this.current !== attempt || attempt.controller.signal.aborted) {
      throw attempt.controller.signal.aborted ? new Canceled() : new StaleGenerationError();
    }
  }

  private async assertOwnedAfter(attempt: InstallAttempt) {
    this.assertCurrent(attempt);
    const stored = await this.ports.loadState();
    if (stored.pending?.installId !== attempt.generation.installId) {
      throw new StaleGenerationError();
    }
    this.state = stored;
  }

  async install(entry: CatalogEntry, options: InstallOptions = {}): Promise<void> {
    await this.init();
    if (this.current) {
      // 同一时间只允许一个安装；重复点击直接忽略。
      return;
    }

    // 锁定演练保护：锁定后只允许“恰好一次”跨版本安装——
    // 即当前版正是锁定版、且尚无“上一版”缓存时安装另一版本（旧激活缓存变为上一版，恰为锁定缓存）。
    // 其余任何安装（含同版重装，以及已有新版后再次安装/升第三版）都需要第三份手册缓存，
    // 必须明确拒绝，绝不删除演练正在使用的资源。
    const fresh = await this.ports.loadState().catch(() => this.state);
    this.state = fresh;
    const lock = fresh.drillLock;
    if (lock) {
      const allowedSingleUpgrade =
        fresh.previousVersion === null &&
        fresh.previousCacheName === null &&
        fresh.activeVersion === lock.version &&
        fresh.activeCacheName === lock.cacheName &&
        fresh.activeGeneration === lock.generation &&
        fresh.activeVersion !== null &&
        entry.version !== fresh.activeVersion;
      if (!allowedSingleUpgrade) {
        this.setStatus({ kind: 'failed', version: entry.version, code: 'locked' });
        return;
      }
    }

    const mode: InstallMode = options.mode === 'reuse' ? 'reuse' : 'full';
    this.activeCatalogEntry = options.activeEntry ?? null;
    this.clearRollbackReview();
    const total = entry.resources.length;
    const version = entry.version;
    const installId = `${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const generation = { version, installId };
    const cacheName = stageCacheNameFor(version, installId);
    const controller = new AbortController();
    const attempt: InstallAttempt = { generation, cacheName, mode, controller };
    this.current = attempt;

    // 清理可能的同名残留（理论上唯一，防御性处理）。
    await this.safeDelete(cacheName);

    this.state = {
      ...this.state,
      pending: { version, cacheName, installId, mode, startedAt: this.ports.now() },
    };
    await this.ports.saveState(this.state);
    this.setInstalling({
      total,
      phase: 'acquire',
      completed: 0,
      reused: 0,
      fetched: 0,
      verified: 0,
      attempt,
    });

    try {
      const staged = await this.acquireResources(entry, attempt);
      await this.assertOwnedAfter(attempt);
      const cache = await this.ports.openCache(cacheName);

      // 复制/下载阶段已校验摘要；入暂存后再逐项读取重验，确保 Cache Storage 中实际落盘内容完整。
      this.setInstalling({
        total,
        phase: 'verify',
        completed: total,
        reused: staged.reused,
        fetched: staged.fetched,
        verified: 0,
        attempt,
      });
      for (let i = 0; i < entry.resources.length; i++) {
        if (controller.signal.aborted) throw new Canceled();
        const ref = entry.resources[i];
        const storedEntry = await cache.get(ref.url);
        if (!storedEntry) throw new ChecksumError(ref.url);
        const actual = normalizeHash(await this.ports.sha256(storedEntry.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        if ((i + 1) % 3 === 0 || i + 1 === total) {
          await this.assertOwnedAfter(attempt);
        }
        this.setInstalling({
          total,
          phase: 'verify',
          completed: total,
          reused: staged.reused,
          fetched: staged.fetched,
          verified: i + 1,
          attempt,
        });
      }

      const manifestActual = normalizeHash(
        await this.ports.sha256(encodeCanonicalResourceList(entry.resources)),
      );
      if (manifestActual !== normalizeHash(entry.resourcesSha256)) {
        throw new ChecksumError('catalog-resources');
      }

      // 原子切换：全部资源、逐项摘要、整单摘要均通过后才提交新代际。
      // 成功后最多保留新版和紧邻的旧当前版；更早或无关的缓存只能在指针切换后回收。
      const replacingDifferentVersion =
        this.state.activeVersion && this.state.activeVersion !== version;
      const previous = replacingDifferentVersion
        ? {
            version: this.state.activeVersion as string,
            cacheName: this.state.activeCacheName as string,
            generation: this.state.activeGeneration as string,
          }
        : null;
      const nextState: PersistedState = {
        activeVersion: version,
        activeCacheName: cacheName,
        activeGeneration: installId,
        previousVersion: previous?.version ?? null,
        previousCacheName: previous?.cacheName ?? null,
        previousGeneration: previous?.generation ?? null,
        pending: null,
        // 锁定演练绑定随安装保留：SW/步骤页改读新激活缓存，锁定演练继续指向锁定缓存。
        drillLock: this.state.drillLock,
      };
      const committed = await this.ports.commitStateIfPending(nextState, installId);
      if (!committed) throw new StaleGenerationError();
      this.state = nextState;

      // 代际已持久提交，再回收当前/上一版之外的任何孤儿缓存。
      await this.reconcileCaches();
      this.notifyGenerationChanged();

      this.current = null;
      this.setStatus({ kind: 'activated', installId, version });
    } catch (err) {
      this.current = null;
      await this.failInstallation(attempt, err);
    }
  }

  /**
   * 退回前复核：逐资源读取上一版缓存中的落盘字节，逐项 SHA-256 校验，
   * 再核对整份资源清单摘要。复核期间不修改 IDB、不删除/切换任何缓存。
   */
  async reviewRollback(entry: CatalogEntry): Promise<RollbackReview | null> {
    await this.init();
    try {
      const state = await this.ports.loadState();
      this.state = state;
      // 锁定优先判定：即使没有上一版，也必须明确告知“因锁定被拒绝”，而非“缺少上一版”。
      if (state.drillLock) {
        throw new LockedDrillError('锁定演练仍在进行，不能退回版本');
      }
      if (this.current || state.pending) throw new RollbackBusyError();
      if (
        !state.activeVersion ||
        !state.activeCacheName ||
        !state.activeGeneration ||
        !state.previousVersion ||
        !state.previousCacheName ||
        !state.previousGeneration
      ) {
        throw new RollbackMissingError();
      }

      const targetEntry = entry;
      if (!targetEntry || targetEntry.version !== state.previousVersion) {
        throw new RollbackMissingError();
      }

      const parsedCacheName = installGenerationFromCacheName(state.previousCacheName);
      if (!parsedCacheName) {
        throw new RollbackMissingError();
      }
      if (
        parsedCacheName.version !== state.previousVersion ||
        parsedCacheName.installId !== state.previousGeneration
      ) {
        throw new RollbackMissingError();
      }

      const cache = await this.ports.openCache(state.previousCacheName);
      for (const ref of targetEntry.resources) {
        const storedEntry = await cache.get(ref.url);
        if (!storedEntry) throw new RollbackMissingError();
        const actual = normalizeHash(await this.ports.sha256(storedEntry.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
      }

      const resourcesActual = normalizeHash(
        await this.ports.sha256(encodeCanonicalResourceList(targetEntry.resources)),
      );
      if (resourcesActual !== normalizeHash(targetEntry.resourcesSha256)) {
        throw new ChecksumError('catalog-resources');
      }

      const review: RollbackReview = {
        version: state.previousVersion,
        cacheName: state.previousCacheName,
        generation: state.previousGeneration,
        resourceCount: targetEntry.resources.length,
        resourcesSha256: targetEntry.resourcesSha256,
      };
      this.rollbackEntry = targetEntry;
      this.rollbackReview = {
        ...review,
        fromVersion: state.activeVersion,
        fromGeneration: state.activeGeneration,
      };
      this.setStatus({ kind: 'rollback-reviewing', review });
      return review;
    } catch (err) {
      await this.failRollback(err, entry.version);
      return null;
    }
  }

  /** 确认退回：在复核通过后执行一次 IndexedDB CAS，并同步交换当前/上一版指针。 */
  async confirmRollback(): Promise<boolean> {
    await this.init();
    const review = this.rollbackReview;
    try {
      if (this.current) throw new RollbackBusyError();
      if (!review) throw new LockedDrillError('锁定演练仍在进行，不能退回版本');

      const state = await this.ports.loadState();
      this.state = state;
      if (state.pending) throw new RollbackBusyError();
      if (state.drillLock) {
        throw new LockedDrillError('锁定演练仍在进行，不能退回版本');
      }
      if (
        state.activeVersion !== review.fromVersion ||
        state.activeGeneration !== review.fromGeneration ||
        state.activeCacheName === null ||
        state.previousVersion !== review.version ||
        state.previousGeneration !== review.generation ||
        state.previousCacheName !== review.cacheName
      ) {
        throw new StaleRollbackError();
      }

      // 确认前再次复核缓存，确保用户停留期间字节没有损坏；此步之后立即 CAS，不做清理。
      const targetEntry = this.rollbackEntry;
      if (!targetEntry || targetEntry.version !== review.version) {
        throw new RollbackMissingError();
      }
      const cache = await this.ports.openCache(review.cacheName);
      for (const ref of targetEntry.resources) {
        const storedEntry = await cache.get(ref.url);
        if (!storedEntry) throw new RollbackMissingError();
        const actual = normalizeHash(await this.ports.sha256(storedEntry.bytes));
        if (actual !== normalizeHash(ref.sha256)) throw new ChecksumError(ref.url);
      }
      const resourcesActual = normalizeHash(
        await this.ports.sha256(encodeCanonicalResourceList(targetEntry.resources)),
      );
      if (resourcesActual !== normalizeHash(targetEntry.resourcesSha256)) {
        throw new ChecksumError('catalog-resources');
      }

      const currentCacheName = state.activeCacheName;
      const currentGeneration = state.activeGeneration;
      const nextState: PersistedState = {
        activeVersion: review.version,
        activeCacheName: review.cacheName,
        activeGeneration: review.generation,
        previousVersion: review.fromVersion,
        previousCacheName: currentCacheName,
        previousGeneration: currentGeneration,
        pending: null,
        drillLock: state.drillLock,
      };
      const committed = await this.ports.commitRollbackIfActive(nextState, {
        activeVersion: review.fromVersion,
        activeGeneration: review.fromGeneration,
        activeCacheName: currentCacheName,
        previousVersion: review.version,
        previousGeneration: review.generation,
        previousCacheName: review.cacheName,
      });
      if (!committed) throw new StaleRollbackError();

      this.state = await this.ports.loadState();
      this.clearRollbackReview();
      // 交换后保留的仍是当前与紧邻上一版；无需删除缓存，SW 只读新的 active 指针。
      this.notifyGenerationChanged();
      this.setStatus({
        kind: 'rolled-back',
        version: review.version,
        fromVersion: review.fromVersion,
        generation: review.generation,
      });
      return true;
    } catch (err) {
      await this.failRollback(err, review?.version ?? null);
      return false;
    }
  }

  cancelRollbackReview(): void {
    if (!this.rollbackReview) return;
    this.clearRollbackReview();
    this.setStatus({ kind: 'idle' });
  }

  private reviewSnapshot(): RollbackReview {
    const review = this.rollbackReview!;
    const { version, cacheName, generation, resourceCount, resourcesSha256 } = review;
    return { version, cacheName, generation, resourceCount, resourcesSha256 };
  }

  private notifyGenerationChanged() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      if (!this.generationChannel) {
        this.generationChannel = new BroadcastChannel('manual-generation');
      }
      this.generationChannel.postMessage({
        type: 'generation-changed',
        activeVersion: this.state.activeVersion,
        activeGeneration: this.state.activeGeneration,
      });
    } catch {
      // 跨标签即时刷新是便利能力；IndexedDB CAS 已保证正确性。
    }
  }

  /**
   * 另一个标签页完成安装/退回后的跨标签同步。
   * 不中断本标签正在运行的安装；安装尝试在 CAS 阶段仍会按 pending/generation 被拒绝。
   */
  async refreshFromStorage(): Promise<void> {
    if (this.current) return;
    const stored = await this.ports.loadState().catch(() => null);
    if (!stored) return;
    this.state = stored;
    // 保留本地已打开的确认单；即使其他标签页已切换，确认单仍保留给用户点击，
    // 点击时由 CAS 返回 stale，明确告知迟到操作未覆盖新代际。安装会主动废弃确认单。
    if (this.rollbackReview) {
      this.setStatus({ kind: 'rollback-reviewing', review: this.reviewSnapshot() });
    } else {
      this.setStatus({ kind: 'idle' });
    }
  }

  /**
   * 开始一次“锁定版本”的演练：把当前激活代际固定为锁定缓存。
   * 失败返回 null 并以 scope:'drill' 上报告错（安装中/无激活版/已有锁定），不改动任何指针与缓存。
   */
  async acquireDrillLock(): Promise<DrillLock | null> {
    await this.init();
    try {
      if (this.current) throw new RollbackBusyError();
      const state = await this.ports.loadState();
      this.state = state;
      if (state.drillLock) {
        throw new LockedDrillError('已有进行中的锁定演练，请先完成或取消');
      }
      if (
        !state.activeVersion ||
        !state.activeCacheName ||
        !state.activeGeneration ||
        !cacheNameMatchesGeneration(state.activeCacheName, state.activeGeneration)
      ) {
        throw new RollbackMissingError();
      }
      const lock: DrillLock = {
        sessionId: `drill-${this.ports.now()}-${Math.random().toString(36).slice(2, 8)}`,
        version: state.activeVersion,
        cacheName: state.activeCacheName,
        generation: state.activeGeneration,
        faultId: '',
        checkedUpTo: 0,
        passed: false,
        records: [],
        startedAt: this.ports.now(),
      };
      const next: PersistedState = { ...state, drillLock: lock };
      await this.ports.saveState(next);
      this.state = next;
      this.notifyDrillLockChanged();
      this.setStatus({ kind: 'idle' });
      return lock;
    } catch (err) {
      const code: FailureCode = toFailureCode(err);
      this.setStatus({ kind: 'failed', version: null, code, scope: 'drill' });
      return null;
    }
  }

  /** 把锁定会话固定到具体故障条目；必须是当前锁定会话，且条目此前未固定。 */
  async pinDrillFault(sessionId: string, faultId: string): Promise<boolean> {
    await this.init();
    const state = await this.ports.loadState().catch(() => this.state);
    const lock = state.drillLock;
    if (!lock || lock.sessionId !== sessionId || !faultId) return false;
    if (lock.faultId && lock.faultId !== faultId) return false;
    if (lock.faultId === faultId) return true;
    const nextLock: DrillLock = { ...lock, faultId, checkedUpTo: 0, passed: false };
    const next: PersistedState = { ...state, drillLock: nextLock };
    await this.ports.saveState(next);
    this.state = next;
    this.notifyDrillLockChanged();
    this.setStatus({ kind: 'idle' });
    return true;
  }

  /**
   * 持久化锁定演练的动作进度与通过记录（每步勾选后写入，刷新可恢复）。
   * 会话标识不匹配或已释放时拒绝，调用方应停止使用过期会话。
   */
  async persistDrillProgress(
    sessionId: string,
    progress: Pick<DrillLock, 'checkedUpTo' | 'passed' | 'records'>,
  ): Promise<boolean> {
    const state = await this.ports.loadState().catch(() => null);
    const lock = state?.drillLock;
    if (!state || !lock || lock.sessionId !== sessionId) return false;
    const nextLock: DrillLock = {
      ...lock,
      checkedUpTo: progress.checkedUpTo,
      passed: progress.passed,
      records: progress.records,
    };
    const next: PersistedState = { ...state, drillLock: nextLock };
    await this.ports.saveState(next);
    this.state = next;
    // 发出新快照驱动 UI 刷新（勾选进度来自持久化的锁定状态，而不是组件本地状态）。
    this.emit();
    return true;
  }

  /** 完成或取消演练：释放锁定并恢复正常安装/回收语义。 */
  async releaseDrillLock(sessionId: string): Promise<boolean> {
    await this.init();
    const state = await this.ports.loadState().catch(() => null);
    if (!state?.drillLock || state.drillLock.sessionId !== sessionId) return false;
    const next: PersistedState = { ...state, drillLock: null };
    await this.ports.saveState(next);
    this.state = next;
    this.notifyDrillLockChanged();
    this.setStatus({ kind: 'idle' });
    return true;
  }

  private notifyDrillLockChanged() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      if (!this.generationChannel) {
        this.generationChannel = new BroadcastChannel('manual-generation');
      }
      this.generationChannel.postMessage({
        type: 'drill-lock-changed',
        sessionId: this.state.drillLock?.sessionId ?? null,
      });
    } catch {
      // 跨标签同步是便利能力；IndexedDB 中的绑定本身已持久化。
    }
  }

  private async failRollback(err: unknown, targetVersion: string | null) {
    // 任何退回失败都不得清理当前版或候选上一版缓存；只刷新状态，拒绝本次操作。
    this.clearRollbackReview();
    this.state = await this.ports.loadState().catch(() => this.state);
    const code: FailureCode = toFailureCode(err);
    this.setStatus({ kind: 'failed', version: targetVersion, code, scope: 'rollback' });
  }

  private setInstalling(data: {
    total: number;
    phase: 'acquire' | 'verify';
    completed: number;
    reused: number;
    fetched: number;
    verified: number;
    attempt: InstallAttempt;
  }) {
    const { total, phase, completed, reused, fetched, verified, attempt } = data;
    const progress =
      phase === 'acquire'
        ? Math.min(89, Math.round(((reused + fetched) / Math.max(1, total)) * 90))
        : 90 + Math.min(9, Math.round((verified / Math.max(1, total)) * 9));
    this.setStatus({
      kind: 'installing',
      installId: attempt.generation.installId,
      mode: attempt.mode,
      version: attempt.generation.version,
      phase,
      progress,
      completed,
      total,
      reused,
      fetched,
      verified,
      cancelRequested: attempt.controller.signal.aborted,
    });
  }

  private async acquireResources(
    entry: CatalogEntry,
    attempt: InstallAttempt,
  ): Promise<{ reused: number; fetched: number; totalBytes: number }> {
    const { resources } = entry;
    const total = resources.length;
    const sourceCacheName = this.state.activeCacheName;
    const byHash = new Map<string, ResourceRef>();
    if (attempt.mode === 'reuse' && this.state.activeVersion && sourceCacheName) {
      this.activeCatalogEntry?.resources.forEach((ref) =>
        byHash.set(normalizeHash(ref.sha256), ref),
      );
    }

    let reused = 0;
    let fetched = 0;
    let knownBytes = 0;
    const collected = new Array<StagedResource>(resources.length);

    const update = () => {
      this.setInstalling({
        total,
        phase: 'acquire',
        completed: reused + fetched,
        reused,
        fetched,
        verified: 0,
        attempt,
      });
    };

    for (let i = 0; i < resources.length; i++) {
      const ref = resources[i];
      if (attempt.controller.signal.aborted) throw new Canceled();
      const source =
        attempt.mode === 'reuse' ? byHash.get(normalizeHash(ref.sha256)) ?? null : null;
      let resource: StagedResource;

      if (source) {
        const cached = sourceCacheName
          ? await this.ports.readCacheEntry(sourceCacheName, source)
          : null;
        if (cached) {
          const actual = normalizeHash(await this.ports.sha256(cached.bytes));
          if (actual !== normalizeHash(ref.sha256)) {
            // 激活缓存异常时不复用；完整安装入口仍可从网络恢复，复用模式按校验失败保护旧版。
            throw new ChecksumError(source.url);
          }
          resource = cached;
          reused++;
        } else {
          throw new ChecksumError(source.url);
        }
      } else {
        resource = await this.ports.fetchResource(ref, attempt.controller.signal);
        if (attempt.controller.signal.aborted) throw new Canceled();
        const actual = normalizeHash(await this.ports.sha256(resource.bytes));
        if (actual !== normalizeHash(ref.sha256)) {
          throw new ChecksumError(ref.url);
        }
        fetched++;
      }

      knownBytes += resource.bytes.byteLength;
      const available = await this.ports.estimateAvailableCapacity();
      if (available !== null && available < knownBytes) {
        throw new QuotaError();
      }

      collected[i] = resource;
      update();
    }

    // 预容量检查不改变旧版；真正写入再由平台配额错误兜底。
    const available = await this.ports.estimateAvailableCapacity();
    if (available !== null && available < knownBytes) {
      throw new QuotaError();
    }

    const cache = await this.ports.openCache(attempt.cacheName);
    for (let i = 0; i < resources.length; i++) {
      if (attempt.controller.signal.aborted) throw new Canceled();
      const ref = resources[i];
      const item = collected[i];
      await cache.put(ref.url, item.bytes, item.contentType);
      if (attempt.controller.signal.aborted) throw new Canceled();
      if ((i + 1) % 3 === 0 || i + 1 === total) {
        await this.assertOwnedAfter(attempt);
      }
    }

    return { reused, fetched, totalBytes: knownBytes };
  }

  private async failInstallation(attempt: InstallAttempt, err: unknown) {
    const code = toFailureCode(err);
    const stale = err instanceof StaleGenerationError || this.current !== null;

    if (!stale) {
      const stored = await this.ports.loadState().catch(() => this.state);
      if (stored.pending?.installId === attempt.generation.installId) {
        this.state = { ...stored, pending: null };
        await this.ports.saveState(this.state).catch(() => undefined);
      } else {
        this.state = stored;
      }
      await this.safeDelete(attempt.cacheName);
      await this.reconcileCaches();
    }

    this.setStatus({
      kind: 'failed',
      installId: attempt.generation.installId,
      version: attempt.generation.version,
      code,
    });
  }

  async cancel(): Promise<void> {
    const attempt = this.current;
    if (!attempt || attempt.controller.signal.aborted) return;
    const status = this.snapshot.status;
    if (status.kind === 'installing' && status.installId === attempt.generation.installId) {
      this.setStatus({ ...status, cancelRequested: true });
    }
    attempt.controller.abort();
  }
}
