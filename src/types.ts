export type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
export type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';
export type ViewId = 'editor' | 'review' | 'compare';

export interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  status: StepStatus;
  comments: ReviewComment[];
}

/**
 * 连续快照之间的字段级增量。
 * 还原时以 baseVersionId 对应版本的完整步骤为基准，
 * 应用 removed / added / changed 三类差异即可得到完整步骤列表。
 */
export interface VersionDelta {
  baseVersionId: string;
  removed: string[];
  added: Array<{ at: number; step: ProcessStep }>;
  changed: Record<string, Partial<ProcessStep>>;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  /** 完整步骤快照；保留版本（批准 / 签名 / 事故关联 / 修订来源）始终持有。 */
  steps?: ProcessStep[];
  /** 字段级增量；与 steps 互斥。 */
  delta?: VersionDelta;
  /** 已批准（冻结通过）。 */
  approved?: boolean;
  /** 已签名。 */
  signed?: boolean;
  /** 关联事故编号。 */
  incidentRef?: string;
  /** 本版本由哪个版本修订而来（值为来源版本 id）。 */
  revisionOf?: string;
}

export interface ExperimentProcess {
  id: string;
  title: string;
  code: string;
  objective: string;
  principal: string;
  lab: string;
  status: ProcessStatus;
  version: string;
  steps: ProcessStep[];
  versions: VersionSnapshot[];
  frozenAt?: string;
  updatedAt: string;
  /** 归档信息版本号；缺少该字段的旧数据会在载入时兼容迁移。 */
  archiveVersion?: number;
}

export interface HistoryState {
  past: ExperimentProcess[];
  present: ExperimentProcess;
  future: ExperimentProcess[];
}

export interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}
