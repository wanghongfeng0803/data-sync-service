/**
 * 纯函数字段映射，同时运行在主线程（inline 回退）与 worker 线程中。
 *
 * mapping 形如：
 * {
 *   "fields": { "目标字段": "源字段（点路径）" },
 *   "defaults": { "目标字段": 默认值 },
 *   "keepUnmapped": true
 * }
 */
function getByPath(obj, path) {
  return path.split('.').reduce((acc, segment) => (acc == null ? undefined : acc[segment]), obj);
}

function applyMapping(data, mapping = {}) {
  const fields = mapping.fields || {};
  const defaults = mapping.defaults || {};
  const output = mapping.keepUnmapped ? { ...data } : {};

  for (const [targetField, sourcePath] of Object.entries(fields)) {
    const value = getByPath(data, sourcePath);
    if (value !== undefined) {
      output[targetField] = value;
    } else if (Object.prototype.hasOwnProperty.call(defaults, targetField)) {
      output[targetField] = defaults[targetField];
    }
  }

  for (const [field, value] of Object.entries(defaults)) {
    if (!(field in output)) output[field] = value;
  }

  return output;
}

module.exports = { applyMapping };
