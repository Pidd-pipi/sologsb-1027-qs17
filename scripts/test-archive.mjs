// 归档逻辑测试：增量重建一致性、保留项、容量拒绝、回滚、旧数据迁移
// 运行：node scripts/test-archive.mjs（由 test 脚本先用 esbuild 打包）
import assert from 'node:assert/strict';
import {
  buildArchivePlan,
  encodeDelta,
  applyDelta,
  materializeVersion,
  migrateProcess,
  runArchiveCompression,
  getProtectedReasons,
  deepEqual,
  ARCHIVE_SCHEMA_VERSION,
  STORAGE_KEY
} from './bundle.mjs';

// 简易内存 localStorage
function createMemoryStorage(initial = {}, failOnSet = null) {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => { store.delete(k); },
    setItem: (k, v) => {
      if (failOnSet && failOnSet(k, v)) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(k, String(v));
    },
    _dump: () => Object.fromEntries(store)
  };
}

function makeStep(id, overrides = {}) {
  return {
    id, title: `步骤${id}`, purpose: '目的', materials: '材料', equipment: '设备',
    amount: '10 mL', duration: 10, hazards: ['易燃液体'], controls: '通风柜操作',
    dependencies: [], safetyNote: '佩戴护目镜', expectedResult: '正常',
    status: 'draft', comments: [], ...overrides
  };
}

function makeSnapshot(id, steps, overrides = {}) {
  return {
    id, label: `版本${id}`, version: `1.${id}.0`, createdAt: '2026-09-20T14:30:00+08:00',
    note: '说明', author: '王颖', steps, storage: 'full', ...overrides
  };
}

function makeProcess(versions) {
  return {
    id: 'exp-1', title: '实验', code: 'CODE-1', objective: '目标', principal: '李',
    lab: 'B-207', status: 'in-review', version: '1.0.0', steps: versions.at(-1).steps,
    versions, updatedAt: '2026-10-01T00:00:00+08:00', archive: { schemaVersion: 2 }
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

// 1. 增量编码 / 重建一致（通过 materializeVersion 验证）
test('连续快照字段差异编码后可无损重建（含增删改与排序）', () => {
  const s1 = [makeStep('a'), makeStep('b'), makeStep('c', { dependencies: ['b'] })];
  const steps2 = [
    makeStep('a', { title: '步骤A改名', comments: [{ id: 'cmt1', author: 'x', role: 'r', text: 't', createdAt: '2026-10-01T00:00:00+08:00', resolved: false }] }),
    makeStep('c', { hazards: ['易燃液体', '粉尘吸入'], controls: '通风柜+口罩' }),
    makeStep('d', { dependencies: ['c'] }) // 新增，且 b 被删除，顺序变化
  ];
  const v1 = makeSnapshot('0', s1);
  const v2 = makeSnapshot('1', steps2);
  const process = makeProcess([v1, v2]);
  const result = runArchiveCompression(process, { storage: createMemoryStorage() });
  const archived = result.nextProcess.versions[1];
  assert.equal(archived.storage, 'delta');
  assert.deepEqual(archived.steps, []);
  const rebuilt = materializeVersion(archived, result.nextProcess.versions);
  assert.ok(deepEqual(rebuilt.steps, steps2), '重建步骤应与原快照深度一致');
  assert.equal(rebuilt.label, v2.label);
  assert.ok(result.reclaimedBytes > 0);
});

// 2. 保留项不参与归档：批准 / 签名 / 事故关联 / 修订来源
test('批准、签名、事故关联、修订来源版本列为保留项，不会被压缩', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const v0 = makeSnapshot('v0', steps);
  const vApproved = makeSnapshot('v1', steps.map((s) => ({ ...s, title: s.title + 'x' })), {
    approval: { approved: true, approver: '王颖', approvedAt: '2026-10-01T00:00:00+08:00' },
    signature: { signed: true, signer: '王颖', signedAt: '2026-10-01T00:01:00+08:00' }
  });
  const vIncident = makeSnapshot('v2', steps.map((s) => ({ ...s, purpose: 'p2' })), {
    incident: { linked: true, incidentCode: 'INC-1', note: 'n', linkedAt: '2026-10-02T00:00:00+08:00' }
  });
  const vRev = makeSnapshot('v3', steps.map((s) => ({ ...s, materials: 'm2' })), { revisionSourceId: 'v1' });
  const process = makeProcess([v0, vApproved, vIncident, vRev]);

  const reasons1 = getProtectedReasons(vApproved, process).sort();
  assert.deepEqual(reasons1, ['approval', 'revision-source', 'signature']);
  const reasons2 = getProtectedReasons(vIncident, process);
  assert.ok(reasons2.includes('incident'));
  const reasons3 = getProtectedReasons(vRev, process);
  assert.deepEqual(reasons3, []); // 自身只是“引用者”，不受保护

  const plan = buildArchivePlan(process);
  const archivedIds = plan.candidates.map((c) => c.version.id);
  assert.ok(!archivedIds.includes('v1'), '批准/签名版本不可回收');
  assert.ok(!archivedIds.includes('v2'), '事故关联版本不可回收');
  // 修订来源 v1 也在候选外；只有无保护的版本才进候选
  assert.ok(archivedIds.every((id) => !['v1', 'v2'].includes(id)));
});

// 3. 修订来源锚点：增量以受保护版本为锚点，重建正确
test('增量锚点为最近的受保护/首版完整快照，多段压缩均可重建', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [
    makeSnapshot('v0', steps),
    makeSnapshot('v1', steps.map((s) => ({ ...s, title: 't1' })), {
      approval: { approved: true, approver: '王颖', approvedAt: '2026-10-01T00:00:00+08:00' }
    }),
    makeSnapshot('v2', steps.map((s) => ({ ...s, title: 't2' }))),
    makeSnapshot('v3', steps.map((s) => ({ ...s, title: 't3' })))
  ];
  const process = makeProcess(versions);
  const result = runArchiveCompression(process, { storage: createMemoryStorage() });
  const [v0, v1, v2, v3] = result.nextProcess.versions;
  assert.equal(v1.storage, 'full');
  assert.equal(v2.storage, 'delta');
  assert.equal(v3.storage, 'delta');
  assert.equal(v2.deltaBasisId, 'v1');
  assert.equal(v3.deltaBasisId, 'v1'); // 单跳锚点，不成链
  assert.ok(deepEqual(materializeVersion(v3, result.nextProcess.versions).steps, versions[3].steps));
  void v0;
});

// 4. 压缩失败（校验后强制失败）恢复归档前数据
test('压缩失败后恢复归档前数据（内存未变 + localStorage 回滚）', () => {
  const storage = createMemoryStorage();
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [
    makeSnapshot('v0', steps),
    makeSnapshot('v1', steps.map((s) => ({ ...s, title: 't1' }))),
    makeSnapshot('v2', steps.map((s) => ({ ...s, title: 't2' })))
  ];
  const process = makeProcess(versions);
  storage.setItem(STORAGE_KEY, JSON.stringify(process));
  const before = storage.getItem(STORAGE_KEY);
  assert.throws(() => runArchiveCompression(process, { storage, forceFailAfterVerify: true }), /模拟/);
  assert.equal(storage.getItem(STORAGE_KEY), before, 'localStorage 必须恢复为归档前原值');
});

// 5. 落盘配额失败 -> 回滚
test('落盘写入配额失败时恢复归档前数据并抛出', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [
    makeSnapshot('v0', steps),
    makeSnapshot('v1', steps.map((s) => ({ ...s, title: 't1' })))
  ];
  const process = makeProcess(versions);
  let writes = 0;
  const storage = createMemoryStorage({}, () => {
    writes += 1;
    // 第 1 次写入为预置归档前数据；第 2 次（归档落盘）失败；回滚写入放行
    return writes === 2;
  });
  storage.setItem(STORAGE_KEY, JSON.stringify(process));
  const before = storage.getItem(STORAGE_KEY);
  assert.throws(() => runArchiveCompression(process, { storage }));
  assert.equal(storage.getItem(STORAGE_KEY), before);
});

// 6. 旧数据迁移：缺 storage / archive 字段
test('旧数据缺少归档信息时兼容迁移并视为完整快照', () => {
  const old = {
    id: 'exp-old', title: '旧实验', code: 'OLD', objective: '', principal: '', lab: '',
    status: 'draft', version: '1.0.0',
    steps: [makeStep('a')],
    versions: [{
      id: 'old-v1', label: '复核通过冻结版', version: '1.0.0', createdAt: '2026-01-01T00:00:00+08:00',
      note: '', author: '王颖', steps: [makeStep('a')]
    }],
    updatedAt: '2026-01-02T00:00:00+08:00'
  };
  const { process, changed } = migrateProcess(old);
  assert.equal(changed, true);
  assert.equal(process.archive?.schemaVersion, ARCHIVE_SCHEMA_VERSION);
  assert.equal(process.versions[0].storage, 'full');
  // 老“复核通过”标签兼容为批准保留项
  assert.equal(process.versions[0].approval?.approved, true);
  // 原对象不被修改
  assert.equal(old.archive, undefined);
});

// 7. 已是最新结构的数据迁移不改写
test('新结构迁移标记 changed=false', () => {
  const process = makeProcess([makeSnapshot('v0', [makeStep('a')])]);
  const { changed } = migrateProcess(JSON.parse(JSON.stringify(process)));
  assert.equal(changed, false);
});

// 8. 归档结果可被版本比较 / 修订分支 / 撤销重做共用
test('归档后同一物化结果供比较/修订/撤销重做读取', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [
    makeSnapshot('v0', steps),
    makeSnapshot('v1', steps.map((s) => ({ ...s, title: '标题v1' }))),
    makeSnapshot('v2', steps.map((s) => ({ ...s, title: '标题v2' })))
  ];
  const process = makeProcess(versions);
  const result = runArchiveCompression(process, { storage: createMemoryStorage() });
  const next = result.nextProcess;
  // 任意两个读取入口得到一致的物化结果
  const read1 = next.versions.map((v) => materializeVersion(v, next.versions));
  const read2 = next.versions.map((v) => materializeVersion(v, next.versions));
  assert.ok(deepEqual(read1, read2));
  assert.ok(deepEqual(read1[2].steps, versions[2].steps));
  assert.ok(deepEqual(read1[1].steps, versions[1].steps));
  // 归档标记落盘
  assert.equal(next.archive.lastArchivedCount, 2);
  assert.ok(next.archive.lastReclaimedBytes > 0);
});

// 9. 容量不足拒绝写入场景由 App 层组装；这里验证可释放空间计算
test('可释放空间为各候选 full-delta 之和且非负', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [
    makeSnapshot('v0', steps),
    makeSnapshot('v1', steps.map((s) => ({ ...s, title: 'x'.repeat(200) }))),
    makeSnapshot('v2', steps.map((s) => ({ ...s, title: 'y'.repeat(200) })))
  ];
  const plan = buildArchivePlan(makeProcess(versions));
  assert.equal(plan.candidates.length, 2);
  const sum = plan.candidates.reduce((n, c) => n + c.reclaimableBytes, 0);
  assert.equal(plan.totalReclaimableBytes, sum);
  plan.candidates.forEach((c) => assert.ok(c.reclaimableBytes >= 0));
});

// 10. 重复归档幂等：已增量版本不再处理
test('重复执行归档不会再次压缩已是增量的版本', () => {
  const steps = [makeStep('a'), makeStep('b')];
  const versions = [makeSnapshot('v0', steps), makeSnapshot('v1', steps.map((s) => ({ ...s, title: 't1' })))];
  const storage = createMemoryStorage();
  const r1 = runArchiveCompression(makeProcess(versions), { storage });
  const r2 = runArchiveCompression(r1.nextProcess, { storage });
  assert.equal(r1.archivedCount, 1);
  assert.equal(r2.archivedCount, 0);
  assert.equal(r2.reclaimedBytes, 0);
});

// 11. 内部增量编码直接校验：未变化步骤不出现在 stepsChanged
test('encodeDelta 仅记录发生变化的字段与增删步骤', () => {
  const v0 = makeSnapshot('v0', [makeStep('a'), makeStep('b')]);
  const v1 = makeSnapshot('v1', [
    makeStep('a', { title: '新名称' }),
    makeStep('b'),
    makeStep('c', { dependencies: ['a'] })
  ]);
  const delta = encodeDelta(v1, v0);
  const changed = delta.stepsChanged.find((d) => d.id === 'a');
  assert.deepEqual(Object.keys(changed.fields), ['title']);
  const unchanged = delta.stepsChanged.find((d) => d.id === 'b');
  assert.equal(unchanged, undefined);
  assert.equal(delta.stepsChanged.find((d) => d.id === 'c')?.kind, 'added');
  // applyDelta 直接重建
  const rebuilt = applyDelta(v0.steps, delta);
  assert.ok(deepEqual(rebuilt, v1.steps));
});

console.log(`\n${passed} 项测试通过`);
