/** IndexedDB 封装：只保存“当前代际与安装状态”一条记录。
 * 手册正文与任何资源都不写入 IndexedDB——离线读取由 Service Worker + Cache Storage 负责。
 * 该模块同时被页面与 Service Worker 使用。
 */
import type { DrillLock, PersistedState } from './types';
import { INITIAL_PERSISTED_STATE } from './types';

const DB_NAME = 'manual-kiosk-db';
const DB_VERSION = 1;
const STORE = 'state';
const KEY = 'current';

type IDBFactoryLike = IDBFactory;

const generationFromCacheName = (cacheName: string): string => {
  const parts = cacheName.split(':');
  return parts.length >= 4 ? parts[parts.length - 1] : '';
};

/** 规范化锁定演练记录；字段缺失或代际/缓存名不自洽时视为无锁定（绝不绑定到错误缓存）。 */
const normalizeDrillLock = (raw: unknown): DrillLock | null => {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Partial<DrillLock>;
  if (
    typeof l.sessionId !== 'string' ||
    typeof l.version !== 'string' ||
    typeof l.cacheName !== 'string' ||
    typeof l.generation !== 'string' ||
    typeof l.faultId !== 'string'
  ) {
    return null;
  }
  if (generationFromCacheName(l.cacheName) !== l.generation) return null;
  const checkedUpTo = Number(l.checkedUpTo);
  const records = Array.isArray(l.records)
    ? l.records
        .filter(
          (r): r is NonNullable<DrillLock['records']>[number] =>
            !!r &&
            typeof r === 'object' &&
            typeof (r as { version?: unknown }).version === 'string' &&
            typeof (r as { entryId?: unknown }).entryId === 'string' &&
            typeof (r as { code?: unknown }).code === 'string',
        )
        .map((r) => ({
          version: r.version,
          entryId: r.entryId,
          totalActions: Number(r.totalActions) || 0,
          passedAt: Number(r.passedAt) || 0,
          code: r.code,
        }))
    : [];
  return {
    sessionId: l.sessionId,
    version: l.version,
    cacheName: l.cacheName,
    generation: l.generation,
    faultId: l.faultId,
    checkedUpTo: Number.isFinite(checkedUpTo) && checkedUpTo >= 0 ? Math.trunc(checkedUpTo) : 0,
    passed: Boolean(l.passed),
    records,
    startedAt: Number(l.startedAt) || 0,
  };
};

export function openStateDb(idbFactory: IDBFactoryLike = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

export async function readState(db?: IDBDatabase): Promise<PersistedState> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!stored || typeof stored !== 'object') {
      return { ...INITIAL_PERSISTED_STATE };
    }
    const s = stored as Partial<PersistedState>;
    const activeCacheName =
      typeof s.activeCacheName === 'string' ? s.activeCacheName : null;
    const pendingCacheName =
      s.pending && typeof s.pending === 'object' && typeof s.pending.cacheName === 'string'
        ? s.pending.cacheName
        : null;
    return {
      activeVersion: typeof s.activeVersion === 'string' ? s.activeVersion : null,
      activeCacheName,
      activeGeneration:
        typeof s.activeGeneration === 'string'
          ? s.activeGeneration
          : activeCacheName
            ? generationFromCacheName(activeCacheName)
            : null,
      previousVersion: typeof s.previousVersion === 'string' ? s.previousVersion : null,
      previousCacheName:
        typeof s.previousCacheName === 'string' ? s.previousCacheName : null,
      previousGeneration:
        typeof s.previousGeneration === 'string'
          ? s.previousGeneration
          : typeof s.previousCacheName === 'string'
            ? generationFromCacheName(s.previousCacheName)
            : null,
      pending:
        s.pending &&
        typeof s.pending === 'object' &&
        typeof s.pending.version === 'string' &&
        pendingCacheName
          ? {
              version: s.pending.version,
              cacheName: pendingCacheName,
              installId:
                typeof s.pending.installId === 'string'
                  ? s.pending.installId
                  : generationFromCacheName(pendingCacheName),
              mode: s.pending.mode === 'reuse' ? 'reuse' : 'full',
              startedAt: Number(s.pending.startedAt) || 0,
            }
          : null,
      drillLock: normalizeDrillLock(s.drillLock),
    };
  } finally {
    if (owned) handle.close();
  }
}

export async function writeState(state: PersistedState, db?: IDBDatabase): Promise<void> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 写入失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 写入中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}

export async function commitStateIfPending(
  state: PersistedState,
  expectedGeneration: string,
  db?: IDBDatabase,
): Promise<boolean> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let committed = false;
      const req = store.get(KEY);
      req.onsuccess = () => {
        const current = req.result as Partial<PersistedState> | undefined;
        const pending = current?.pending as PersistedState['pending'] | undefined;
        if (pending?.installId !== expectedGeneration) {
          // 请求成功但代次不属于本次尝试：不能写入，也不能中止其他代次。
          return;
        }
        // 安装期间其他标签页若开始/释放了锁定演练，本次提交不得用旧锁定覆盖其决定。
        const currentLock = normalizeDrillLock(current?.drillLock);
        const nextLock = normalizeDrillLock(state.drillLock);
        if ((currentLock?.sessionId ?? null) !== (nextLock?.sessionId ?? null)) {
          return;
        }
        store.put(state, KEY);
        committed = true;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 提交失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 提交中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}

export async function commitRollbackIfActive(
  state: PersistedState,
  expected: {
    activeVersion: string;
    activeGeneration: string;
    activeCacheName: string;
    previousVersion: string;
    previousGeneration: string;
    previousCacheName: string;
  },
  db?: IDBDatabase,
): Promise<boolean> {
  const owned = !db;
  const handle = db ?? (await openStateDb());
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const tx = handle.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let committed = false;
      const req = store.get(KEY);
      req.onsuccess = () => {
        const current =
          req.result && typeof req.result === 'object'
            ? (req.result as Partial<PersistedState>)
            : {};
        if (
          current.pending ||
          // 锁定演练期间退回一律拒绝：退回会使锁定缓存变成“上一版”，随时可能被下一次安装回收。
          normalizeDrillLock(current.drillLock) ||
          current.activeVersion !== expected.activeVersion ||
          current.activeGeneration !== expected.activeGeneration ||
          current.activeCacheName !== expected.activeCacheName ||
          current.previousVersion !== expected.previousVersion ||
          current.previousGeneration !== expected.previousGeneration ||
          current.previousCacheName !== expected.previousCacheName
        ) {
          return;
        }
        store.put(state, KEY);
        committed = true;
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(committed);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 退回提交失败'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 退回提交中止'));
    });
  } finally {
    if (owned) handle.close();
  }
}
