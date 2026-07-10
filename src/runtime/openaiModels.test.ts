import { describe, expect, it } from 'vitest';
import { classifyModelTier, suggestFastStrongModels } from './openaiModels.js';

describe('openaiModels', () => {
  it('classifies haiku as fast and sonnet as strong', () => {
    expect(classifyModelTier('aws-bedrock/claude-haiku-4-5')).toBe('fast');
    expect(classifyModelTier('aws-bedrock/claude-sonnet-4-5')).toBe('strong');
  });

  it('suggests fast/strong picks from model list', () => {
    const models = [
      'aws-bedrock/claude-haiku-4-5',
      'aws-bedrock/claude-sonnet-4-5',
      'aws-bedrock/claude-opus-4-6',
    ];
    const { fast, strong } = suggestFastStrongModels(models);
    expect(fast).toBe('aws-bedrock/claude-haiku-4-5');
    expect(strong).toBe('aws-bedrock/claude-sonnet-4-5');
  });
});
