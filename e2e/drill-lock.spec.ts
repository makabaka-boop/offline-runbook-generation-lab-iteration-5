import { expect, test } from '@playwright/test';
import { clearFaultRules, setFaultRules } from './helpers';

/**
 * “锁定本次演练版本”离线验收：
 * - 锁定后允许安装一版新手册：普通步骤页切新版，演练资源读取/动作次序/通过记录始终指向锁定版；
 * - 半包失败、刷新恢复、再次安装/退回需要第三份缓存时明确拒绝且不删锁定资源；
 * - 完成或取消才释放锁定；释放后可再次安装。全程在断网下验证锁定版仍可读。
 */

const install = async (page: import('@playwright/test').Page, version: string) => {
  await page.getByTestId(`install-${version}`).click();
  await expect(page.getByTestId('current-version')).toContainText(version);
};

const manualCacheNames = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('manual:')));

const readDrillLock = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const req = indexedDB.open('manual-kiosk-db');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('state', 'readonly');
    const get = tx.objectStore('state').get('current');
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      get.onsuccess = () => resolve(get.result as Record<string, unknown>);
      get.onerror = () => reject(get.error);
    });
    db.close();
    return state.drillLock as {
      sessionId: string;
      version: string;
      cacheName: string;
      faultId: string;
      checkedUpTo: number;
      passed: boolean;
    } | null;
  });

/** 在锁定版完成一条演练的全部动作（v1 UPS 条目固定 4 步）。 */
const completeLockedUpsDrill = async (page: import('@playwright/test').Page) => {
  await page.getByTestId('tab-drill').click();
  await page.getByTestId('fault-search').fill('UPS');
  await page.getByTestId('fault-v1-ups-overload').click();
  for (let i = 0; i < 4; i++) {
    await page.getByTestId(`action-v1-ups-overload-${i}`).click();
  }
  await expect(page.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
  await expect(page.getByTestId('pass-code')).toContainText('PASS-1.0.0-');
};

test.describe('锁定本次演练版本', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await install(page, '1.0.0');
  });

  test('安装成功：锁定后装上 v2，普通步骤页是 v2，演练始终读锁定版 v1；断网刷新后恢复绑定', async ({
    page,
    context,
  }) => {
    // 开始锁定演练并固定条目
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('lock-checkbox').check();
    await page.getByTestId('lock-start').click();
    await expect(page.getByTestId('drill-lock-banner')).toContainText('已锁定版本 1.0.0');

    const lockBefore = await readDrillLock(page);
    expect(lockBefore).not.toBeNull();
    expect(lockBefore!.version).toBe('1.0.0');

    await page.getByTestId('fault-search').fill('UPS');
    await page.getByTestId('fault-v1-ups-overload').click();
    await page.getByTestId('action-v1-ups-overload-0').click();
    await page.getByTestId('action-v1-ups-overload-1').click();

    // 另一位维护员安装新版 v2：成功
    await page.getByTestId('tab-steps').click();
    await install(page, '2.0.0');
    await expect(page.getByTestId('step-1')).toContainText('双总线');

    // 锁定提示标明普通页与演练已分叉；不弹“演练已终止”
    await expect(page.getByTestId('drill-lock-diverged')).toContainText('普通步骤页当前为版本 2.0.0');
    await expect(page.getByTestId('drill-terminated')).toHaveCount(0);

    // 演练面板仍是锁定版 v1：条目、动作次序与勾选进度保持
    await page.getByTestId('tab-drill').click();
    await expect(page.getByTestId('drill-panel')).toContainText('版本 1.0.0');
    await expect(page.getByTestId('fault-v1-ups-overload')).toBeVisible();
    await expect(page.getByTestId('fault-v2-sts-failover')).toHaveCount(0);
    await expect(page.getByTestId('action-v1-ups-overload-2')).toBeEnabled();
    await expect(page.getByTestId('action-v1-ups-overload-0')).toContainText('已完成');

    // v2 的故障条目在锁定版里不存在：锁定读取不允许混入新版
    await page.getByTestId('fault-search').fill('STS');
    await expect(page.getByTestId('fault-empty')).toBeVisible();
    await page.getByTestId('fault-search').fill('UPS');
    await page.getByTestId('action-v1-ups-overload-2').click();
    await page.getByTestId('action-v1-ups-overload-3').click();
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
    await expect(page.getByTestId('pass-history')).toContainText('版本 1.0.0');

    const lockAfter = await readDrillLock(page);
    expect(lockAfter!.version).toBe('1.0.0');
    expect(lockAfter!.cacheName).toBe(lockBefore!.cacheName);
    expect(lockAfter!.checkedUpTo).toBe(4);
    expect(lockAfter!.passed).toBe(true);

    // 锁定版缓存与 v2 激活缓存同时保留（恰好两份）
    const names = await manualCacheNames(page);
    expect(names).toHaveLength(2);
    expect(names).toContain(lockAfter!.cacheName);

    // 断网刷新：普通页仍 v2，演练会话与版本绑定恢复（进度、通过记录、锁定版资源可读）
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    await expect(page.getByTestId('step-1')).toContainText('双总线');
    await expect(page.getByTestId('drill-lock-banner')).toContainText('已锁定版本 1.0.0');
    await page.getByTestId('tab-drill').click();
    await expect(page.getByTestId('drill-panel')).toContainText('版本 1.0.0');
    await page.getByTestId('fault-search').fill('UPS');
    await expect(page.getByTestId('fault-v1-ups-overload')).toBeVisible();
    await expect(page.getByTestId('pass-box')).toContainText('绑定版本 1.0.0');
    await expect(page.getByTestId('pass-history')).toContainText('版本 1.0.0');
    await context.setOffline(false);

    // 完成释放后：绑定解除，可再次安装
    await page.getByTestId('lock-cancel').click();
    await expect(page.getByTestId('drill-lock-banner')).toHaveCount(0);
    expect(await readDrillLock(page)).toBeNull();

    await page.getByTestId('tab-steps').click();
    await page.getByTestId('install-3.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
  });

  test('半包失败：锁定后安装 v2 中途断网，暂存缓存清理；v2 未激活且锁定版 v1 离线继续可读', async ({
    page,
    context,
  }) => {
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('lock-checkbox').check();
    await page.getByTestId('lock-start').click();
    await expect(page.getByTestId('drill-lock-banner')).toBeVisible();
    const lock = (await readDrillLock(page))!;

    await setFaultRules(page, [{ match: '/manuals/v2/manifest.json', behavior: 'abort' }]);
    await page.getByTestId('tab-steps').click();
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('failed-banner')).toContainText('下载中断');
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');

    // 半包缓存被清理；锁定缓存（= 激活缓存）仍在
    const names = await manualCacheNames(page);
    expect(names).toEqual([lock.cacheName]);
    expect(await readDrillLock(page)).toMatchObject({ sessionId: lock.sessionId });

    // 断网刷新：锁定演练照常读取 v1
    await clearFaultRules(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('current-version')).toContainText('1.0.0');
    await expect(page.getByTestId('drill-lock-banner')).toContainText('1.0.0');
    await completeLockedUpsDrill(page);
    await context.setOffline(false);

    // 网络恢复后同一版本安装仍可成功（失败未生成混合版本）
    await page.getByTestId('tab-steps').click();
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    expect(await readDrillLock(page)).toMatchObject({ version: '1.0.0' });
  });

  test('需要第三份手册缓存时明确拒绝：锁定并装上 v2 后，再装 v1/v3 与退回均被拒绝，资源不删', async ({
    page,
  }) => {
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('lock-checkbox').check();
    await page.getByTestId('lock-start').click();
    await page.getByTestId('tab-steps').click();
    await install(page, '2.0.0');
    const namesAfterUpgrade = await manualCacheNames(page);
    expect(namesAfterUpgrade).toHaveLength(2);

    // 再次安装（第三版）被拒绝
    await page.getByTestId('install-3.0.0').click();
    await expect(page.getByTestId('failed-banner')).toContainText('锁定演练仍在进行');
    await expect(page.getByTestId('current-version')).toContainText('2.0.0');
    // 同版重装同样拒绝
    await page.getByTestId('install-2.0.0').click();
    await expect(page.getByTestId('failed-banner')).toContainText('需要第三份手册缓存');

    // 退回入口禁用；即使存在上一版也不允许
    await expect(page.getByTestId('rollback-review')).toBeDisabled();
    await expect(page.getByTestId('rollback-locked-note')).toBeVisible();

    // 锁定资源与 v2 资源都未被删除
    const names = await manualCacheNames(page);
    expect(names.sort()).toEqual(namesAfterUpgrade.sort());
    const lock = await readDrillLock(page);
    expect(names).toContain(lock!.cacheName);

    // 取消演练释放锁定后，第三版可装
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('lock-cancel').click();
    await page.getByTestId('tab-steps').click();
    await page.getByTestId('install-3.0.0').click();
    await expect(page.getByTestId('current-version')).toContainText('3.0.0');
  });

  test('未锁定时沿用切版终止演练语义；锁定在完成演练前不允许悄悄换条目', async ({ page }) => {
    // 不勾选锁定：切版终止（回归保障）
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('fault-v1-pdu-trip').click();
    await page.getByTestId('action-v1-pdu-trip-0').click();
    await page.getByTestId('tab-steps').click();
    await install(page, '2.0.0');
    await expect(page.getByTestId('switch-notice')).toContainText('未完成演练已终止');
    await expect(page.getByTestId('drill-lock-banner')).toHaveCount(0);

    // 锁定后条目固定：选了 STS 后，其他条目不允许再选（当前激活版为 v2）
    await page.getByTestId('tab-drill').click();
    await page.getByTestId('lock-checkbox').check();
    await page.getByTestId('lock-start').click();
    await expect(page.getByTestId('drill-lock-banner')).toContainText('已锁定版本 2.0.0');
    await page.getByTestId('fault-search').fill('STS');
    await page.getByTestId('fault-v2-sts-failover').click();
    await page.getByTestId('fault-search').fill('温度');
    await expect(page.getByTestId('fault-v2-hot-aisle-temp-high')).toBeDisabled();
  });
});
