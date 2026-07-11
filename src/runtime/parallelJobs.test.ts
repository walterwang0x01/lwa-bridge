import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetParallelJobsForTests,
  createParallelJob,
  getParallelJob,
  listParallelJobs,
  updateParallelJob,
} from './parallelJobs.js';

describe('parallelJobs', () => {
  beforeEach(() => _resetParallelJobsForTests());

  it('creates and lists jobs', () => {
    const j = createParallelJob({
      parentConversationId: 'cli-code',
      childConversationId: 'cli-par-a',
      worktreeName: 'feat-a',
      cwd: '/tmp/wt',
      promptPreview: 'do stuff',
    });
    expect(j.status).toBe('running');
    expect(listParallelJobs('cli-code')).toHaveLength(1);
    updateParallelJob(j.id, { status: 'done', finishedAt: Date.now(), summaryPreview: 'ok' });
    expect(getParallelJob(j.id)?.status).toBe('done');
  });
});
