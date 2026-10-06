import { useEffect, useMemo, useRef, useState } from 'react';
import type { DrillLock, FaultEntry } from '../core/types';
import {
  buildPassRecord,
  checkNext,
  isActionUnlocked,
  searchEntries,
  selectEntry,
  startDrill,
  type DrillSession,
  type PassRecord,
} from '../core/drill';
import type { ManualBundle } from '../manuals';
import { coordinator } from '../state/use-installer';

interface Props {
  /** 普通（未锁定）模式下当前激活版本。 */
  version: string;
  entries: FaultEntry[];
  /** 进行中的锁定演练绑定（含刷新恢复后的进度）。 */
  drillLock: DrillLock | null;
  /** 从锁定代际缓存读取的手册包；锁定模式下演练条目与动作以它为准。 */
  lockedBundle: ManualBundle | null;
  /** 未锁定模式下版本切换终止未完成演练时回调。 */
  onTerminated: (previousVersion: string) => void;
  /** 未锁定模式下旧版本通过记录失效时回调。 */
  onRecordsInvalidated: (previousVersion: string, count: number) => void;
}

const recordsFromLock = (lock: DrillLock, entries: FaultEntry[]): PassRecord[] =>
  lock.records.map((r) => ({
    version: r.version,
    entryId: r.entryId,
    entryTitle: entries.find((e) => e.id === r.entryId)?.title ?? r.entryId,
    totalActions: r.totalActions,
    passedAt: r.passedAt,
    code: r.code,
  }));

export function DrillPanel({
  version,
  entries,
  drillLock,
  lockedBundle,
  onTerminated,
  onRecordsInvalidated,
}: Props) {
  // 普通（未锁定）模式的本地会话状态。
  const [session, setSession] = useState<DrillSession | null>(null);
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<PassRecord[]>([]);
  // “锁定本次演练版本”开关：默认关闭，沿用现有切版即终止演练的语义。
  const [wantLock, setWantLock] = useState(false);
  const [busy, setBusy] = useState(false);

  const previousVersionRef = useRef(version);
  const sessionRef = useRef<DrillSession | null>(null);
  const recordsRef = useRef<PassRecord[]>([]);
  sessionRef.current = session;
  recordsRef.current = records;

  // 锁定模式下实际使用的版本/条目/会话（刷新后从 IDB 绑定恢复）。
  const lockEntries = lockedBundle?.faults ?? null;
  const lockVersion = drillLock?.version ?? null;
  const lockSession: DrillSession | null = drillLock
    ? {
        version: drillLock.version,
        selectedEntryId: drillLock.faultId || null,
        checkedUpTo: drillLock.checkedUpTo,
        passed: drillLock.passed,
      }
    : null;
  const lockRecords: PassRecord[] = useMemo(
    () => (drillLock && lockEntries ? recordsFromLock(drillLock, lockEntries) : []),
    [drillLock, lockEntries],
  );

  // 未锁定模式：版本切换终止未完成演练、失效旧结论。
  // 锁定模式不受激活版本变化影响（锁定会话固定在 drillLock 上）。
  useEffect(() => {
    if (drillLock) {
      previousVersionRef.current = version;
      return;
    }
    const previousVersion = previousVersionRef.current;
    if (previousVersion === version) return;

    const previousSession = sessionRef.current;
    if (
      previousSession?.version === previousVersion &&
      previousSession.selectedEntryId !== null &&
      !previousSession.passed
    ) {
      onTerminated(previousVersion);
    }

    const staleRecords = recordsRef.current;
    if (staleRecords.length > 0) {
      const staleCount = staleRecords.filter((record) => record.version === previousVersion).length;
      onRecordsInvalidated(previousVersion, staleCount);
      setRecords([]);
    }

    setSession(startDrill(version));
    setQuery('');
    previousVersionRef.current = version;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, drillLock]);

  // 未锁定模式：进入演练页时确保有一个当前版会话。
  useEffect(() => {
    if (drillLock) return;
    if (!session) {
      setSession(startDrill(version));
    } else if (session.version !== version) {
      setSession(startDrill(version));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, drillLock]);

  const activeSession = drillLock ? lockSession : session;
  const activeEntries = drillLock ? lockEntries : entries;
  const activeVersion = drillLock ? lockVersion : version;
  const activeRecords = drillLock ? lockRecords : records;

  const results = useMemo(
    () => (activeEntries ? searchEntries(activeEntries, query) : []),
    [activeEntries, query],
  );
  const selected =
    activeEntries && activeSession?.selectedEntryId
      ? activeEntries.find((e) => e.id === activeSession.selectedEntryId) ?? null
      : null;

  const handleStart = async () => {
    if (!wantLock || drillLock || busy) return;
    setBusy(true);
    const lock = await coordinator.acquireDrillLock();
    setBusy(false);
    if (lock) {
      setWantLock(true);
      setSession(null);
      setQuery('');
    }
  };

  const handleRelease = async () => {
    if (!drillLock) return;
    setBusy(true);
    await coordinator.releaseDrillLock(drillLock.sessionId);
    setBusy(false);
    setWantLock(false);
    setQuery('');
  };

  const handleSelect = async (entry: FaultEntry) => {
    if (drillLock) {
      // 锁定会话条目只固定一次；演练做到一半不允许换条目（不悄悄换步骤）。
      if (drillLock.faultId) return;
      const pinned = await coordinator.pinDrillFault(drillLock.sessionId, entry.id);
      if (!pinned) return;
      return;
    }
    setSession((s) => (s ? selectEntry(s, entry) : startDrill(version)));
  };

  const handleCheck = (index: number) => {
    if (!activeSession || !selected || !activeVersion) return;
    const next = checkNext(activeSession, selected, index);
    if (next === activeSession) return;

    if (drillLock) {
      const newRecord = next.passed
        ? buildPassRecord(next, selected, Date.now())
        : null;
      const snapshots = newRecord
        ? [
            ...drillLock.records,
            {
              version: newRecord.version,
              entryId: newRecord.entryId,
              totalActions: newRecord.totalActions,
              passedAt: newRecord.passedAt,
              code: newRecord.code,
            },
          ]
        : drillLock.records;
      // 每步勾选都持久化：刷新后动作次序与通过记录仍指向锁定版。
      void coordinator.persistDrillProgress(drillLock.sessionId, {
        checkedUpTo: next.checkedUpTo,
        passed: next.passed,
        records: snapshots,
      });
      return;
    }

    setSession(next);
    if (next.passed) {
      const record = buildPassRecord(next, selected, Date.now());
      if (record) setRecords((rs) => [record, ...rs]);
    }
  };

  return (
    <div className="panel" data-testid="drill-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          离线故障演练
          {activeVersion && <span> · 版本 {activeVersion}</span>}
        </h2>
        <span className="badge">
          {drillLock ? '已锁定本版（刷新后恢复）' : '只能选择当前版条目'}
        </span>
      </div>

      {!drillLock && (
        <div className="row lock-toggle" data-testid="lock-toggle" style={{ marginTop: 10 }}>
          <label>
            <input
              type="checkbox"
              data-testid="lock-checkbox"
              checked={wantLock}
              onChange={(e) => setWantLock(e.target.checked)}
            />{' '}
            锁定本次演练版本
          </label>
          <button
            type="button"
            className="primary"
            data-testid="lock-start"
            disabled={!wantLock || busy}
            onClick={() => void handleStart()}
          >
            {busy ? '正在锁定…' : '开始锁定演练'}
          </button>
          <span className="small">
            锁定后即使其他维护员安装了新手册，本演练的资源读取、动作次序与通过记录也始终固定在当前版；
            不锁定则沿用“切换版本即终止演练”的现有语义。
          </span>
        </div>
      )}

      {drillLock && (
        <div className="row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="danger"
            data-testid="lock-cancel"
            disabled={busy}
            onClick={() => void handleRelease()}
          >
            {drillLock.passed ? '完成并释放锁定' : '取消演练并释放锁定'}
          </button>
          <span className="small">
            完成或取消后才释放锁定；释放前需要第三份手册缓存的安装/退回会被明确拒绝。
          </span>
        </div>
      )}

      {drillLock && !lockedBundle && (
        <div className="small" data-testid="locked-bundle-loading" style={{ marginTop: 12 }}>
          正在从锁定代际缓存离线读取版本 {drillLock.version} 的故障条目…
        </div>
      )}

      {activeEntries && (
        <>
          <div style={{ marginTop: 12 }}>
            <input
              type="search"
              data-testid="fault-search"
              placeholder={
                drillLock
                  ? `搜索锁定版 ${drillLock.version} 的故障条目`
                  : '搜索当前版故障条目，如：UPS、跳闸、STS、温度'
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="fault-list" data-testid="fault-list">
            {results.map((entry) => {
              const pinnedElsewhere =
                drillLock !== null && drillLock.faultId !== '' && drillLock.faultId !== entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`fault-item ${activeSession?.selectedEntryId === entry.id ? 'on' : ''}`}
                  data-testid={`fault-${entry.id}`}
                  disabled={pinnedElsewhere}
                  onClick={() => void handleSelect(entry)}
                >
                  <strong>{entry.title}</strong>
                  <div className="small" style={{ marginTop: 4, textAlign: 'left' }}>
                    {entry.symptoms}
                  </div>
                </button>
              );
            })}
            {results.length === 0 && (
              <div className="small" data-testid="fault-empty">
                {drillLock ? '锁定版未找到匹配条目。' : '当前版未找到匹配条目。'}
              </div>
            )}
          </div>

          {selected && activeSession && (
            <div className="panel" style={{ background: 'var(--panel-2)', marginTop: 14 }}>
              <h2 style={{ fontSize: 15 }}>{selected.title}</h2>
              <div className="small">{selected.symptoms}</div>
              <ul className="action-list" data-testid="action-list">
                {selected.actions.map((action, i) => {
                  const unlocked = isActionUnlocked(activeSession, i);
                  const done = i < activeSession.checkedUpTo;
                  return (
                    <li key={i} className={unlocked || done ? '' : 'locked'}>
                      <span className="idx">{done ? '✓' : i + 1}</span>
                      <span style={{ flex: 1 }}>{action}</span>
                      <button
                        type="button"
                        data-testid={`action-${selected.id}-${i}`}
                        disabled={!unlocked}
                        onClick={() => handleCheck(i)}
                      >
                        {done ? '已完成' : '勾选本步'}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {activeSession.passed && (
                <div className="pass-box" data-testid="pass-box">
                  <div style={{ fontWeight: 700 }}>演练通过</div>
                  <div className="small" style={{ margin: '6px 0' }}>
                    本结论绑定版本 {activeVersion} · {selected.title}
                  </div>
                  <code data-testid="pass-code">
                    PASS-{activeVersion}-
                    {activeRecords.find((r) => r.entryId === selected.id)?.code ?? '----'}
                  </code>
                  {drillLock && (
                    <div className="small" style={{ marginTop: 6 }}>
                      锁定仍未释放：点击“完成并释放锁定”后其他维护员才能再次安装/退回。
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeRecords.length > 0 && (
            <div className="history" data-testid="pass-history">
              <strong>已通过结论（按版本绑定）：</strong>
              <ul>
                {activeRecords.map((r) => (
                  <li key={r.code} data-testid={`record-${r.code}`}>
                    版本 {r.version} · {r.entryTitle} · 编号 {r.code}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
