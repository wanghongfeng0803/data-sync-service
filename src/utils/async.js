function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleWithConcurrency(items, limit, worker) {
  const queue = items.slice();
  const count = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: count }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

module.exports = { sleep, settleWithConcurrency };
