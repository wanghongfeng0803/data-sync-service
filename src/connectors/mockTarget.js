/**
 * 内存 Mock 目标：默认成功；可通过每条记录内嵌的 __flaky 字段或全局配置
 * 模拟前 N 次失败，用于验证指数退避重试与死信逻辑。
 *
 * config: { failAttempts?: number, failKeys?: string[] }
 * record: { key, data, attempts }
 */
async function push(record, config = {}, context = {}) {
  const failAttempts = Number.isFinite(config.failAttempts) ? config.failAttempts : 0;
  const failKeys = Array.isArray(config.failKeys) ? config.failKeys : [];
  const attempts = context.attempts ?? 0;

  if (failKeys.includes(record.key)) {
    throw Object.assign(new Error(`mock target permanent failure for ${record.key}`), {
      retryable: false,
    });
  }
  if (attempts <= failAttempts) {
    throw Object.assign(
      new Error(`mock target transient failure (attempt ${attempts})`),
      { retryable: true },
    );
  }
  return { ok: true, key: record.key, pushedAt: new Date().toISOString() };
}

module.exports = { type: 'mock', push };
