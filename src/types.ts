// 实验流程领域模型与版本归档相关类型

type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';
type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';
export type ViewId = 'editor' | 'review' | 'compare' | 'archive';

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

/** 归档不可触碰的保留元数据：批准、签名、事故关联、修订来源 */
export interface ApprovalRecord {
  approved: boolean;
  approver: string;
  approvedAt: string;
}

export interface SignatureRecord {
  signed: boolean;
  signer: string;
  signedAt: string;
}

export interface IncidentLink {
  linked: boolean;
  incidentCode: string;
  note: string;
  linkedAt: string;
}

/**
 * 版本快照。
 * - storage=full：完整快照（含 steps）。
 * - storage=delta：连续快照收成的字段级增量，steps 为空，
 *   相对 deltaBasisId 指向的“完整锚点”重建；header 中保留全部非步骤字段。
 * 批准 / 签名 / 事故关联 / 修订来源始终整体保留，不参与差异压缩。
 */
export interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  steps: ProcessStep[];
  /** 修订来源：本版本从哪个冻结版本修订而来；该来源版本受保留保护。 */
  revisionSourceId?: string;
  /** 保留项：批准记录 */
  approval?: ApprovalRecord;
  /** 保留项：电子签名 */
  signature?: SignatureRecord;
  /** 保留项：事故关联 */
  incident?: IncidentLink;
  storage?: 'full' | 'delta';
  deltaBasisId?: string;
  archivedAt?: string;
}

export interface ArchiveInfo {
  schemaVersion: number;
  lastArchivedAt?: string;
  lastReclaimedBytes?: number;
  lastArchivedCount?: number;
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
  /** 当前修订稿所基于的冻结版本；该版本在修订期间作为修订来源受保留保护。 */
  revisionBasisVersionId?: string;
  archive?: ArchiveInfo;
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

export type { StepStatus, ProcessStatus };
