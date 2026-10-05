// 版本归档：连续完整快照按字段差异收成增量；
// 批准、签名、事故关联、修订来源为保留项，永不参与回收。
// 压缩失败恢复归档前数据，并保证版本比较 / 修订分支 / 撤销重做读取同一份结果。

import type { ExperimentProcess, ProcessStep, VersionSnapshot } from './types';
import { STORAGE_KEY, byteSize } from './storage';

export const ARCHIVE_SCHEMA_VERSION = 2;

/** 参与步骤级字段差异的字段（顺序即差异展示顺序）。 */
export const STEP_FIELDS = [
  'title',
  'purpose',
  'materials',
  'equipment',
  'amount',
  'duration',
  'hazards',
  'controls',
  'dependencies',
  'safetyNote',
  'expectedResult',
  'status',
  'comments'
] as const satisfies readonly (keyof ProcessStep)[];

/** 快照头部字段（非步骤），增量版本始终整体保留，不做字段级压缩。 */
const SNAPSHOT_HEADER_FIELDS = ['label', 'version', 'note', 'author', 'createdAt'] as const;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => deepEqual(
    (a as Record<string, unknown>)[key],
    (b as Record<string, unknown>)[key]
  ));
}

// ---------------------------------------------------------------------------
// 增量编码 / 重建
// ---------------------------------------------------------------------------

export interface StepDelta {
  id: string;
  kind: 'changed' | 'added';
  fields: Partial<ProcessStep>;
}

export interface VersionDelta {
  kind: 'version-delta';
  basisId: string;
  stepsChanged: StepDelta[];
  removedStepIds: string[];
  addedOrder: string[];
}

/** 以完整锚点 basis 为基准，将完整快照 full 编码为字段级增量。 */
export function encodeDelta(full: VersionSnapshot, basis: VersionSnapshot): VersionDelta {
  const basisMap = new Map(basis.steps.map((step) => [step.id, step]));
  const stepsChanged: StepDelta[] = [];

  full.steps.forEach((step) => {
    const before = basisMap.get(step.id);
    if (!before) {
      stepsChanged.push({ id: step.id, kind: 'added', fields: { ...step } });
      return;
    }
    const fields: Partial<ProcessStep> = {};
    STEP_FIELDS.forEach((field) => {
      if (!deepEqual(before[field], step[field])) {
        (fields as Record<string, unknown>)[field] = cloneValue(step[field]);
      }
    });
    if (Object.keys(fields).length) stepsChanged.push({ id: step.id, kind: 'changed', fields });
  });

  const fullIds = new Set(full.steps.map((step) => step.id));
  const removedStepIds = basis.steps.filter((step) => !fullIds.has(step.id)).map((step) => step.id);
  return {
    kind: 'version-delta',
    basisId: basis.id,
    stepsChanged,
    removedStepIds,
    addedOrder: full.steps.map((step) => step.id)
  };
}

/** 按增量在完整锚点上重建步骤集合。 */
export function applyDelta(basisSteps: ProcessStep[], delta: VersionDelta): ProcessStep[] {
  const changedMap = new Map(delta.stepsChanged.map((item) => [item.id, item]));
  const removed = new Set(delta.removedStepIds);

  const byId = new Map<string, ProcessStep>();
  basisSteps.forEach((step) => {
    if (removed.has(step.id)) return;
    const change = changedMap.get(step.id);
    if (change) {
      byId.set(step.id, { ...step, ...cloneValue(change.fields) });
    } else {
      byId.set(step.id, cloneValue(step));
    }
    changedMap.delete(step.id);
  });
  // 锚点中不存在的新增步骤
  changedMap.forEach((change, id) => {
    if (change.kind === 'added') byId.set(id, cloneValue(change.fields) as ProcessStep);
  });

  const result: ProcessStep[] = [];
  delta.addedOrder.forEach((id) => {
    const step = byId.get(id);
    if (step) {
      result.push(step);
      byId.delete(id);
    }
  });
  // 防御：增量未记录顺序的步骤追加在末尾
  byId.forEach((step) => result.push(step));
  return result;
}

/**
 * 把任意存储形态的版本物化为完整快照。版本比较、修订分支、撤销重做后
 * 都通过同一个入口读取，保证结果一致。
 */
export function materializeVersion(
  version: VersionSnapshot,
  allVersions: VersionSnapshot[]
): VersionSnapshot {
  if (version.storage !== 'delta' || !version.deltaBasisId) {
    return cloneValue(version);
  }
  const basis = allVersions.find((item) => item.id === version.deltaBasisId);
  if (!basis) {
    // 旧数据损坏：锚点缺失时返回头部 + 空步骤，由界面提示，不抛异常
    return { ...cloneValue(version), steps: [], storage: 'full', deltaBasisId: undefined };
  }
  const fullBasis = materializeVersion(basis, allVersions);
  const delta = parseDelta(version);
  if (!delta) return { ...cloneValue(version), steps: [], storage: 'full', deltaBasisId: undefined };
  const steps = applyDelta(fullBasis.steps, delta);
  const restored: VersionSnapshot = {
    ...cloneValue(version),
    steps,
    storage: 'full',
    deltaBasisId: undefined
  };
  return restored;
}

/** 增量数据存放在 steps 之外的私有字段（JSON 序列化无损）。 */
interface StoredDeltaSnapshot extends VersionSnapshot {
  deltaData?: VersionDelta;
}

export function parseDelta(version: VersionSnapshot): VersionDelta | null {
  const data = (version as StoredDeltaSnapshot).deltaData;
  if (data && data.kind === 'version-delta' && data.basisId === version.deltaBasisId) return data;
  return null;
}

function toDeltaSnapshot(full: VersionSnapshot, basis: VersionSnapshot, archivedAt: string): VersionSnapshot {
  const delta = encodeDelta(full, basis);
  const header: StoredDeltaSnapshot = {
    ...full,
    steps: [],
    storage: 'delta',
    deltaBasisId: basis.id,
    archivedAt,
    deltaData: delta
  };
  // 保留项原样随头部保存
  return header;
}

// ---------------------------------------------------------------------------
// 保留项
// ---------------------------------------------------------------------------

export type ProtectedReason = 'approval' | 'signature' | 'incident' | 'revision-source';

export const PROTECTED_REASON_LABEL: Record<ProtectedReason, string> = {
  approval: '已批准',
  signature: '已签名',
  incident: '事故关联',
  'revision-source': '修订来源'
};

export function getProtectedReasons(version: VersionSnapshot, process: ExperimentProcess): ProtectedReason[] {
  const reasons: ProtectedReason[] = [];
  if (version.approval?.approved) reasons.push('approval');
  if (version.signature?.signed) reasons.push('signature');
  if (version.incident?.linked) reasons.push('incident');
  const referencedAsSource = process.versions.some(
    (other) => other.id !== version.id && other.revisionSourceId === version.id
  ) || process.revisionBasisVersionId === version.id;
  if (referencedAsSource) reasons.push('revision-source');
  return reasons;
}

export function isProtectedVersion(version: VersionSnapshot, process: ExperimentProcess): boolean {
  return getProtectedReasons(version, process).length > 0;
}

// ---------------------------------------------------------------------------
// 归档计划：可释放空间 / 可回收候选
// ---------------------------------------------------------------------------

export interface ArchiveCandidate {
  version: VersionSnapshot;
  fullBytes: number;
  deltaBytes: number;
  reclaimableBytes: number;
  basisId: string;
}

export interface ArchivePlan {
  candidates: ArchiveCandidate[];
  totalReclaimableBytes: number;
  protectedVersions: { version: VersionSnapshot; reasons: ProtectedReason[] }[];
  deltaVersions: VersionSnapshot[];
}

/**
 * 计算归档方案：
 * - 已是增量的版本跳过；
 * - 保留项（批准 / 签名 / 事故关联 / 修订来源）跳过；
 * - 每个候选相对最近的前置完整锚点（保留项或首版）做单跳增量，
 *   重建只依赖一个稳定锚点，避免长链恢复失败。
 */
export function buildArchivePlan(process: ExperimentProcess): ArchivePlan {
  const versions = process.versions;
  const protectedIds = new Set(
    versions.filter((version) => isProtectedVersion(version, process)).map((version) => version.id)
  );

  const candidates: ArchiveCandidate[] = [];
  const deltaVersions: VersionSnapshot[] = [];
  let anchor: VersionSnapshot | null = versions[0] ?? null;

  versions.forEach((version, index) => {
    if (index === 0) return; // 首版始终作为完整锚点
    if (version.storage === 'delta') {
      deltaVersions.push(version);
      return;
    }
    if (protectedIds.has(version.id) || !anchor) {
      // 保留项本身成为新的完整锚点
      anchor = version;
      return;
    }
    const fullBytes = measureFull(version);
    const deltaBytes = measureDelta(toDeltaSnapshot(version, anchor, version.archivedAt ?? ''));
    const reclaimableBytes = Math.max(0, fullBytes - deltaBytes);
    if (reclaimableBytes > 0) {
      candidates.push({ version, fullBytes, deltaBytes, reclaimableBytes, basisId: anchor.id });
    }
  });

  const protectedVersions = versions
    .filter((version) => protectedIds.has(version.id))
    .map((version) => ({ version, reasons: getProtectedReasons(version, process) }));

  return {
    candidates,
    totalReclaimableBytes: candidates.reduce((sum, item) => sum + item.reclaimableBytes, 0),
    protectedVersions,
    deltaVersions
  };
}

function measureFull(version: VersionSnapshot): number {
  return byteSize(JSON.stringify(version));
}

function measureDelta(version: VersionSnapshot): number {
  // 归档后 steps 字段不再输出；估算时与实际存储形态保持一致
  const { steps: _steps, ...rest } = version;
  return byteSize(JSON.stringify(rest));
}

// ---------------------------------------------------------------------------
// 执行压缩（带回滚）
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  nextProcess: ExperimentProcess;
  archivedVersions: VersionSnapshot[];
  reclaimedBytes: number;
  archivedCount: number;
  archivedAt: string;
}

export interface ArchiveOptions {
  /** 仅归档指定版本（默认归档全部候选）。 */
  onlyIds?: string[];
  /** 测试钩子：重建校验通过后强制失败，验证回滚。 */
  forceFailAfterVerify?: boolean;
  storage?: Storage;
  now?: () => string;
}

/**
 * 压缩失败后恢复归档前数据：
 * 1. 先在内存中生成增量并逐个“重建 + 深度比对”，任何不一致即中止、不写入；
 * 2. 落盘前备份当前 localStorage 原值，写入或后续步骤失败则恢复原值。
 */
export function runArchiveCompression(process: ExperimentProcess, options: ArchiveOptions = {}): ArchiveResult {
  const storage = options.storage ?? localStorage;
  const now = options.now ?? (() => new Date().toISOString());
  const archivedAt = now();
  const plan = buildArchivePlan(process);
  const allow = new Set(options.onlyIds ?? plan.candidates.map((item) => item.version.id));
  const chosen = plan.candidates.filter((item) => allow.has(item.version.id));

  let backup: string | null = null;
  try {
    backup = storage.getItem(STORAGE_KEY);
  } catch {
    backup = null;
  }

  try {
    // 第一阶段：内存中构建全部目标版本并校验重建结果
    const replacements = new Map<string, VersionSnapshot>();
    const materializedAll = process.versions.map((version) => materializeVersion(version, process.versions));
    const fullById = new Map(materializedAll.map((version) => [version.id, version]));

    let reclaimedBytes = 0;
    const basisToDelta = new Map<string, StoredDeltaSnapshot>();

    chosen.forEach((candidate) => {
      const full = fullById.get(candidate.version.id);
      const basis = fullById.get(candidate.basisId);
      if (!full || !basis) throw new Error(`归档失败：缺少版本或锚点（${candidate.version.id}）`);

      const deltaSnapshot = toDeltaSnapshot(full, basis, archivedAt);
      basisToDelta.set(full.id, deltaSnapshot);

      // 重建并逐字段深度比对（含头部与保留项）
      const delta = parseDelta(deltaSnapshot);
      if (!delta) throw new Error(`归档失败：增量编码无效（${full.id}）`);
      const rebuiltSteps = applyDelta(basis.steps, delta);
      if (rebuiltSteps.length !== full.steps.length || !deepEqual(rebuiltSteps, full.steps)) {
        throw new Error(`归档失败：重建结果与原快照不一致（${full.id}）`);
      }
      SNAPSHOT_HEADER_FIELDS.forEach((field) => {
        if (!deepEqual(deltaSnapshot[field], full[field])) {
          throw new Error(`归档失败：头部字段 ${field} 未能保留（${full.id}）`);
        }
      });
      if (!deepEqual(
        { approval: deltaSnapshot.approval, signature: deltaSnapshot.signature, incident: deltaSnapshot.incident, revisionSourceId: deltaSnapshot.revisionSourceId },
        { approval: full.approval, signature: full.signature, incident: full.incident, revisionSourceId: full.revisionSourceId }
      )) {
        throw new Error(`归档失败：保留项校验未通过（${full.id}）`);
      }
      reclaimedBytes += candidate.reclaimableBytes;
      replacements.set(full.id, deltaSnapshot);
    });

    if (options.forceFailAfterVerify && replacements.size > 0) {
      throw new Error('归档失败（模拟）：校验后写入失败，触发回滚');
    }

    // 第二阶段：生成下一状态
    const nextVersions = process.versions.map((version) => replacements.get(version.id) ?? version);
    const nextProcess: ExperimentProcess = {
      ...process,
      versions: nextVersions,
      archive: {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        lastArchivedAt: archivedAt,
        lastReclaimedBytes: reclaimedBytes,
        lastArchivedCount: replacements.size,
      }
    };

    // 第三阶段：整状态落盘，失败恢复归档前 localStorage 数据
    let writeError: unknown = null;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(nextProcess));
    } catch (error) {
      writeError = error;
    }
    if (writeError) {
      if (backup !== null) {
        try { storage.setItem(STORAGE_KEY, backup); } catch { /* 尽力恢复 */ }
      } else {
        try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      }
      throw writeError instanceof Error ? writeError : new Error('归档写入失败');
    }

    return {
      nextProcess,
      archivedVersions: [...replacements.values()],
      reclaimedBytes,
      archivedCount: replacements.size,
      archivedAt
    };
  } catch (error) {
    // 恢复归档前数据
    if (backup !== null) {
      try { storage.setItem(STORAGE_KEY, backup); } catch { /* 尽力恢复 */ }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 旧数据兼容迁移
// ---------------------------------------------------------------------------

/**
 * 旧数据缺少归档信息时先兼容迁移：
 * - 补齐 archive / schemaVersion；
 * - 老版本没有 storage 字段的视为完整快照；
 * - 按老版本标签兼容推断历史批准记录，不丢失保留语义。
 */
export function migrateProcess(raw: unknown): { process: ExperimentProcess; changed: boolean } {
  if (!raw || typeof raw !== 'object') throw new Error('无效的流程数据');
  const source = raw as ExperimentProcess;
  if (!source.id || !Array.isArray(source.steps) || !Array.isArray(source.versions)) {
    throw new Error('流程数据结构不完整');
  }
  let changed = false;
  const process = cloneValue(source);

  process.versions.forEach((version) => {
    if (!Array.isArray(version.steps)) {
      version.steps = [];
      changed = true;
    }
    if (!version.storage) {
      version.storage = 'full';
      changed = true;
    }
    // 老数据：“批准/复核通过”标签视为历史批准保留项
    if (!version.approval && /(批准|复核通过)/.test(`${version.label}${version.note}`)) {
      version.approval = { approved: true, approver: version.author || '历史复核人', approvedAt: version.createdAt };
      changed = true;
    }
  });

  if (!process.archive || process.archive.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    process.archive = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      lastArchivedAt: process.archive?.lastArchivedAt,
      lastReclaimedBytes: process.archive?.lastReclaimedBytes,
      lastArchivedCount: process.archive?.lastArchivedCount
    };
    changed = true;
  }
  return { process, changed };
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
