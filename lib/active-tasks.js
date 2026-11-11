/**
 * 宿主侧的活跃任务探测：有没有正在生成的回合、运行中的 job。
 * 自动上传、重启前的检查都用它。
 */
export function activeTasks(ctx) {
  const result = { active: false, tasks: 0, jobs: 0 };
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const jobs = ctx && typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
    if (!agents || typeof agents.list !== 'function') return result;
    const live = agents.list() || [];

    const busy = live.filter(agent => {
      if (!agent) return false;
      if (agent.status === 'running') return true;
      const nextTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0;
      const nextStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0;
      return nextTurn + nextStep > 0;
    });
    result.tasks = busy.length;

    if (jobs && typeof jobs.list === 'function') {
      const seen = new Set();
      for (const agent of [undefined, ...live]) {
        let list = [];
        try {
          list = jobs.list(agent ? agent.id : undefined) || [];
        } catch {
          list = [];
        }
        for (const job of list) {
          if (!job || (job.status !== 'running' && job.status !== 'stopping')) continue;
          const key = job.id === undefined || job.id === null ? job : 'id:' + job.id;
          if (seen.has(key)) continue;
          seen.add(key);
          result.jobs += 1;
        }
      }
    }
    result.active = result.tasks > 0 || result.jobs > 0;
  } catch {
    return { active: false, tasks: 0, jobs: 0 };
  }
  return result;
}
