import type { ExperimentProcess, ProcessStep, VersionDelta, VersionSnapshot } from './types';

export const STORAGE_KEY = 'sologsb-1027-lab-safety-v1';
export const ARCHIVE_VERSION = 1;

const STEP_FIELDS: Array<keyof ProcessStep> = [
  'title', 'purpose', 'materials', 'equipment', 'amount', 'duration',
  'hazards', 'controls', 'dependencies', 'safetyNote', 'expectedResult', 'status', 'comments'
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 还原指定版本的完整步骤列表。
 * 沿 delta.baseVersionId 一路回溯到持有完整 steps 的版本，再顺序应用增量。
 * 任一环节无法解析时返回 null，由调用方决定如何回退。
 */
export function resolveVersionSteps(versions: VersionSnapshot[], versionId: string): ProcessStep[] | null {
  const version = versions.find((item) => item.id === versionId);
  if (!version) return null;
  if (version.steps) return clone(version.steps);
  if (version.delta) {
    const base = resolveVersionSteps(versions, version.delta.baseVersionId);
    if (!base) return null;
    return applyDelta(base, version.delta);
  }
  return null;
}

function applyDelta(base: ProcessStep[], delta: VersionDelta): ProcessStep[] {
  const map = new Map<string, ProcessStep>();
  for (const step of base) map.set(step.id, clone(step));
  for (const id of delta.removed) map.delete(id);
  for (const { step } of delta.added) map.set(step.id, clone(step));
  for (const [id, patch] of Object.entries(delta.changed)) {
    const existing = map.get(id);
    if (existing) map.set(id, { ...existing, ...clone(patch) });
  }
  const ordered: string[] = base.map((step) => step.id).filter((id) => !delta.removed.includes(id));
  const addedSorted = [...delta.added].sort((a, b) => b.at - a.at);
  for (const { at, step } of addedSorted) {
    const pos = Math.min(Math.max(at, 0), ordered.length);
    ordered.splice(pos, 0, step.id);
  }
  return ordered.map((id) => map.get(id)).filter((step): step is ProcessStep => Boolean(step));
}

function diffSteps(before: ProcessStep[], after: ProcessStep[]): VersionDelta {
  const beforeMap = new Map(before.map((step) => [step.id, step]));
  const afterMap = new Map(after.map((step) => [step.id, step]));
  const removed = before.filter((step) => !afterMap.has(step.id)).map((step) => step.id);
  const added: VersionDelta['added'] = [];
  after.forEach((step, index) => {
    if (!beforeMap.has(step.id)) added.push({ at: index, step: clone(step) });
  });
  const changed: Record<string, Partial<ProcessStep>> = {};
  for (const afterStep of after) {
    const beforeStep = beforeMap.get(afterStep.id);
    if (!beforeStep) continue;
    const patch: Record<string, unknown> = {};
    for (const field of STEP_FIELDS) {
      if (!deepEqual(beforeStep[field], afterStep[field])) {
        patch[field] = clone(afterStep[field]);
      }
    }
    if (Object.keys(patch).length) changed[afterStep.id] = patch as Partial<ProcessStep>;
  }
  return { baseVersionId: '', removed, added, changed };
}

/**
 * 判断版本是否属于保留项：已批准、已签名、事故关联，或作为修订来源。
 */
export function isRetained(version: VersionSnapshot, versions: VersionSnapshot[]): boolean {
  if (version.approved) return true;
  if (version.signed) return true;
  if (version.incidentRef) return true;
  if (versions.some((item) => item.revisionOf === version.id)) return true;
  return false;
}

function retainReason(version: VersionSnapshot, versions: VersionSnapshot[]): string | null {
  const reasons: string[] = [];
  if (version.approved) reasons.push('已批准');
  if (version.signed) reasons.push('已签名');
  if (version.incidentRef) reasons.push(`事故关联 ${version.incidentRef}`);
  if (versions.some((item) => item.revisionOf === version.id)) reasons.push('修订来源');
  return reasons.length ? reasons.join('、') : null;
}

export interface ReclaimCandidate {
  versionId: string;
  label: string;
  version: string;
  bytes: number;
  retained: boolean;
  reason: string | null;
}

export interface ReclaimReport {
  totalBytes: number;
  reclaimableBytes: number;
  archivableCount: number;
  retainedCount: number;
  candidates: ReclaimCandidate[];
}

function versionStepsBytes(version: VersionSnapshot): number {
  return version.steps ? JSON.stringify(version.steps).length : 0;
}

/**
 * 先算可释放空间：逐版本统计完整步骤占用的字节数，
 * 保留版本（含基础版本）不计入可回收量。
 */
export function computeReclaimable(process: ExperimentProcess): ReclaimReport {
  const totalBytes = JSON.stringify(process).length;
  let reclaimableBytes = 0;
  let archivableCount = 0;
  let retainedCount = 0;
  const candidates: ReclaimCandidate[] = process.versions.map((version, index) => {
    const retained = index === 0 || isRetained(version, process.versions);
    const bytes = versionStepsBytes(version);
    if (retained) retainedCount += 1;
    else if (version.steps) {
      reclaimableBytes += bytes;
      archivableCount += 1;
    }
    return {
      versionId: version.id,
      label: version.label,
      version: version.version,
      bytes,
      retained,
      reason: index === 0 ? '基础版本' : retainReason(version, process.versions)
    };
  });
  return { totalBytes, reclaimableBytes, archivableCount, retainedCount, candidates };
}

export interface ArchiveResult {
  ok: boolean;
  process: ExperimentProcess;
  freedBytes: number;
  archivedCount: number;
  error?: string;
}

/**
 * 归档：把连续的非保留完整快照按字段差异收成增量。
 * 事务性处理——任一版本无法解析即判定失败，返回归档前的原始数据，
 * 保证版本比较、修订分支与撤销重做读取到同一结果。
 */
export function archiveProcess(input: ExperimentProcess): ArchiveResult {
  // 保留归档前数据的引用；压缩失败时原样返回，
  // 保证版本比较、修订分支与撤销重做读取到同一结果。
  const fallback = input;
  try {
    const source = clone(input);
    const next: ExperimentProcess = { ...source, versions: [] };
    let resolvedSteps: ProcessStep[] = [];
    let freedBytes = 0;
    let archivedCount = 0;

    for (let index = 0; index < source.versions.length; index += 1) {
      const version = source.versions[index];
      const retained = index === 0 || isRetained(version, source.versions);
      if (retained) {
        const steps = version.steps ? clone(version.steps) : resolveVersionSteps(source.versions, version.id);
        if (!steps) throw new Error(`保留版本 ${version.version} 无法解析`);
        resolvedSteps = steps;
        next.versions.push({ ...version, steps, delta: undefined });
      } else if (version.steps) {
        const delta = diffSteps(resolvedSteps, version.steps);
        delta.baseVersionId = source.versions[index - 1]?.id ?? '';
        const beforeBytes = JSON.stringify(version.steps).length;
        const afterBytes = JSON.stringify(delta).length;
        resolvedSteps = applyDelta(resolvedSteps, delta);
        freedBytes += Math.max(0, beforeBytes - afterBytes);
        archivedCount += 1;
        next.versions.push({ ...version, steps: undefined, delta });
      } else {
        const steps = resolveVersionSteps(source.versions, version.id);
        if (!steps) throw new Error(`版本 ${version.version} 增量无法解析`);
        resolvedSteps = steps;
        next.versions.push({ ...version });
      }
    }

    next.archiveVersion = ARCHIVE_VERSION;
    for (const version of next.versions) {
      if (!resolveVersionSteps(next.versions, version.id)) {
        throw new Error(`版本 ${version.version} 归档后校验失败`);
      }
    }
    return { ok: true, process: next, freedBytes, archivedCount };
  } catch (error) {
    return { ok: false, process: fallback, freedBytes: 0, archivedCount: 0, error: String(error) };
  }
}

/**
 * 兼容迁移：旧数据缺少归档信息时，把既有完整快照视为归档基础，
 * 补齐保留标记与 archiveVersion，不改动任何步骤内容。
 */
export function migrateProcess(parsed: unknown): ExperimentProcess | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Partial<ExperimentProcess>;
  if (!Array.isArray(candidate.steps) || !Array.isArray(candidate.versions) || candidate.versions.length === 0) {
    return null;
  }
  let mutated = false;
  const versions = candidate.versions.map((raw) => {
    const version = raw as VersionSnapshot;
    if (!version.steps && !version.delta) {
      mutated = true;
      return { ...version, steps: [] as ProcessStep[] };
    }
    if (version.steps && version.delta) {
      mutated = true;
      return { ...version, delta: undefined };
    }
    return version;
  });
  void mutated;
  for (const version of versions) {
    if (!resolveVersionSteps(versions, version.id)) return null;
  }
  return { ...candidate, versions, archiveVersion: ARCHIVE_VERSION } as ExperimentProcess;
}

export interface PersistResult {
  ok: boolean;
  reason?: 'quota' | 'error';
  candidates?: ReclaimCandidate[];
  needed?: number;
  totalBytes?: number;
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'QuotaExceededError'
    || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error.code === 22
    || error.code === 1014;
}

/**
 * 写入 localStorage。容量不足时拒绝写入并返回可回收候选，
 * 由调用方向用户确认后再执行归档回收。
 */
export function persistProcess(process: ExperimentProcess): PersistResult {
  const value = JSON.stringify(process);
  const totalBytes = value.length;
  try {
    localStorage.setItem(STORAGE_KEY, value);
    return { ok: true, totalBytes };
  } catch (error) {
    if (isQuotaError(error)) {
      const report = computeReclaimable(process);
      return {
        ok: false,
        reason: 'quota',
        candidates: report.candidates.filter((item) => !item.retained && item.bytes > 0),
        needed: totalBytes,
        totalBytes
      };
    }
    return { ok: false, reason: 'error', totalBytes };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
