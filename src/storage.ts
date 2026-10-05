// 浏览器本地存储封装：容量估算、配额探测、写入拒绝（配额错误）

export const STORAGE_KEY = 'sologsb-1027-lab-safety-v1';

/** 保守的 localStorage 容量基线；navigator.storage 可用时取两者较小值。 */
export const FALLBACK_QUOTA_BYTES = 5 * 1024 * 1024;
/** 容量告警水位（90%）。 */
export const SPACE_WARNING_RATIO = 0.9;

export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: 'quota'; error: unknown }
  | { ok: false; reason: 'error'; error: unknown };

/** localStorage 以 UTF-16 存储，长度按字符计即近似字节占用。 */
export function byteSize(value: string): number {
  return value.length;
}

/** 当前源下 localStorage 已用字符数（本应用键 + 同域其他键，作为整体容量口径）。 */
export function getUsedBytes(storage: Storage = localStorage): number {
  let total = 0;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null) continue;
    try {
      total += key.length + (storage.getItem(key)?.length ?? 0);
    } catch {
      // 某些键可能不可读，跳过
    }
  }
  return total;
}

/** 探测可用配额（字节）。无法探测时使用保守基线。 */
export async function getQuotaBytes(): Promise<number> {
  const nav = navigator as Navigator & {
    storage?: { estimate?: () => Promise<{ quota?: number }> };
  };
  let estimated = Number.POSITIVE_INFINITY;
  try {
    const estimate = await nav.storage?.estimate?.();
    if (typeof estimate?.quota === 'number' && estimate.quota > 0) {
      estimated = estimate.quota;
    }
  } catch {
    // 忽略探测失败
  }
  return Math.min(FALLBACK_QUOTA_BYTES, estimated);
}

export interface CapacityStatus {
  usedBytes: number;
  quotaBytes: number;
  freeBytes: number;
  ratio: number;
  warning: boolean;
}

export async function getCapacity(): Promise<CapacityStatus> {
  const quotaBytes = await getQuotaBytes();
  const usedBytes = getUsedBytes();
  const freeBytes = Math.max(0, quotaBytes - usedBytes);
  const ratio = quotaBytes > 0 ? usedBytes / quotaBytes : 0;
  return { usedBytes, quotaBytes, freeBytes, ratio, warning: ratio >= SPACE_WARNING_RATIO };
}

/** 判断写入异常是否为配额不足（浏览器错误名/码并不统一）。 */
export function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError'
      || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || error.code === 22
      || error.code === 1014;
  }
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/**
 * 写入本地存储；容量不足时不抛出，返回 quota 结果，由调用方列出可回收候选。
 */
export function saveToStorage(value: string, storage: Storage = localStorage): SaveOutcome {
  try {
    storage.setItem(STORAGE_KEY, value);
    return { ok: true };
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota', error };
    // 隐私模式下部分浏览器即使配额不足也以普通异常抛出
    if (error instanceof DOMException && error.name === 'W3CException_DOM_QUOTA_REACHED') {
      return { ok: false, reason: 'quota', error };
    }
    return { ok: false, reason: 'error', error };
  }
}

export function loadFromStorage(storage: Storage = localStorage): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 容量单位格式化（按字节，约等于字符数口径）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
