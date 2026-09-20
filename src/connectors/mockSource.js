/**
 * 内存 Mock 数据源：按配置生成确定性记录，用于本地验证与自动化测试。
 * config: { count?: number, keyPrefix?: string, failFetch?: boolean }
 */
async function fetch(config = {}) {
  if (config.failFetch) {
    throw new Error('mock source forced fetch failure');
  }
  const count = Number.isFinite(config.count) ? config.count : 10;
  const prefix = config.keyPrefix || 'item';
  return Array.from({ length: count }, (_unused, index) => {
    const number = index + 1;
    return {
      key: `${prefix}-${number}`,
      data: {
        id: number,
        name: `${prefix} ${number}`,
        amount: number * 10,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
      },
    };
  });
}

module.exports = { type: 'mock', fetch };
