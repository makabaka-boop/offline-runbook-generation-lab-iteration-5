import { useEffect, useMemo, useRef, useState } from 'react';
import { coordinator, useInstaller } from '../state/use-installer';
import { catalog, findEntry, loadManual, type ManualBundle } from '../manuals';
import type { DrillLock, FailureCode, InstallMode, InstallerStatus } from '../core/types';
import { FAILURE_TEXT } from '../core/types';
import { NoPackage } from './NoPackage';
import { Workshop } from './Workshop';

interface Props {
  swReady: boolean;
}

export function Booted({ swReady }: Props) {
  const { snapshot, ready } = useInstaller();
  const [bundle, setBundle] = useState<ManualBundle | null>(null);
  const [bundleVersion, setBundleVersion] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string>('');
  const [switchNotice, setSwitchNotice] = useState(false);
  const [lockedBundle, setLockedBundle] = useState<ManualBundle | null>(null);
  const [lockLoadError, setLockLoadError] = useState<string>('');

  const active = snapshot.activeVersion;
  const lock = snapshot.drillLock;
  const prevActiveRef = useRef<string | null>(null);
  const lockRef = useRef(lock);
  lockRef.current = lock;

  // 读取当前激活版本的手册正文（离线由 SW 激活缓存提供）。
  useEffect(() => {
    if (!ready || !active) {
      setBundle(null);
      setBundleVersion(null);
      prevActiveRef.current = active;
      return;
    }
    if (bundleVersion === active && bundle) return;
    let alive = true;
    setLoadError('');
    const previous = prevActiveRef.current;
    loadManual(active)
      .then((b) => {
        if (!alive) return;
        // 锁定演练期间的切版不终止演练：不弹“演练已终止”提示。
        if (previous && previous !== active && !lockRef.current) setSwitchNotice(true);
        setBundle(b);
        setBundleVersion(active);
        prevActiveRef.current = active;
      })
      .catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, [ready, active, bundleVersion, bundle]);

  // 锁定演练：始终从锁定代际缓存读取（普通步骤页已切新版时也不受影响）。
  useEffect(() => {
    if (!ready || !lock) {
      setLockedBundle(null);
      setLockLoadError('');
      return;
    }
    let alive = true;
    setLockLoadError('');
    loadManual(lock.version, lock.cacheName)
      .then((b) => {
        if (alive) setLockedBundle(b);
      })
      .catch((err: Error) => {
        if (alive) setLockLoadError(err.message || '锁定版手册读取失败');
      });
    return () => {
      alive = false;
    };
  }, [ready, lock?.sessionId, lock?.version, lock?.cacheName]);

  const installing = snapshot.status.kind === 'installing' ? snapshot.status : null;
  const failed = snapshot.status.kind === 'failed' ? snapshot.status : null;
  const activated = snapshot.status.kind === 'activated' ? snapshot.status : null;
  const rolledBack = snapshot.status.kind === 'rolled-back' ? snapshot.status : null;

  const activeCatalogEntry = useMemo(
    () => (active ? findEntry(active) : undefined),
    [active],
  );
  const previousCatalogEntry = useMemo(
    () => (snapshot.previousVersion ? findEntry(snapshot.previousVersion) : undefined),
    [snapshot.previousVersion],
  );
  const rollbackStatus =
    snapshot.status.kind === 'rollback-reviewing' ? snapshot.status : null;

  const startInstall = (version: string, mode: InstallMode) => {
    const entry = findEntry(version);
    if (!entry) return;
    void coordinator.install(entry, {
      mode,
      activeEntry: mode === 'reuse' ? activeCatalogEntry ?? null : null,
    });
  };

  const reviewRollback = () => {
    const entry = previousCatalogEntry;
    if (entry) void coordinator.reviewRollback(entry);
  };

  const confirmRollback = () => {
    void coordinator.confirmRollback();
  };

  if (!ready) {
    return (
      <div className="banner info" data-testid="boot-loading">
        正在恢复安装状态…
      </div>
    );
  }

  if (!active) {
    return (
      <NoPackage
        catalog={catalog}
        swReady={swReady}
        installing={installing}
        failed={failed as { version: string | null; code: FailureCode } | null}
        failureText={FAILURE_TEXT}
        onInstall={startInstall}
        onCancel={() => void coordinator.cancel()}
      />
    );
  }

  return (
    <Workshop
      swReady={swReady}
      catalog={catalog}
      activeVersion={active}
      activeTitle={activeCatalogEntry?.title ?? ''}
      releasedAt={activeCatalogEntry?.releasedAt ?? ''}
      bundle={bundle}
      bundleVersion={bundleVersion}
      loadError={loadError}
      installing={installing}
      failed={failed as { version: string | null; code: FailureCode; scope?: 'install' | 'rollback' | 'drill' } | null}
      activated={activated}
      rolledBack={rolledBack}
      previousVersion={snapshot.previousVersion}
      previousTitle={previousCatalogEntry?.title ?? ''}
      rollbackStatus={rollbackStatus as Extract<InstallerStatus, { kind: 'rollback-reviewing' }> | null}
      drillLock={lock}
      lockedBundle={lockedBundle}
      lockLoadError={lockLoadError}
      onReleaseDrillLock={(sessionId) => void coordinator.releaseDrillLock(sessionId)}
      onReviewRollback={reviewRollback}
      onConfirmRollback={confirmRollback}
      onCancelRollbackReview={() => coordinator.cancelRollbackReview()}
      failureText={FAILURE_TEXT}
      switchNotice={switchNotice}
      dismissSwitchNotice={() => setSwitchNotice(false)}
      onInstall={startInstall}
      onCancel={() => void coordinator.cancel()}
    />
  );
}
