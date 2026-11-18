import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheHitRateLabel, coverageHint, metricTokens } from '../lib/format';
import type { MetricsFieldCoverage } from '../api/types';

const unknown: MetricsFieldCoverage = { reportedRequests: 0, totalRequests: 3, state: 'unknown' };
const partial: MetricsFieldCoverage = { reportedRequests: 2, totalRequests: 3, state: 'partial' };
const known: MetricsFieldCoverage = { reportedRequests: 3, totalRequests: 3, state: 'known' };

test('token 数值：未报告不显示 0，部分覆盖带标记，已知与旧数据保持原样', () => {
  assert.equal(metricTokens(0, unknown), '未报告');
  assert.equal(metricTokens(1234, partial), '1.2k（部分）');
  assert.equal(metricTokens(1234, known), '1.2k');
  assert.equal(metricTokens(0, undefined), '0');
  assert.equal(metricTokens(1234567, undefined), '1.2M');
});

test('覆盖提示：partial/unknown 给出 reported/total，known 与旧数据不提示', () => {
  assert.equal(coverageHint(partial), '2/3 个请求报告');
  assert.equal(coverageHint(unknown), '0/3 个请求报告');
  assert.equal(coverageHint(known), undefined);
  assert.equal(coverageHint(undefined), undefined);
});

test('缓存命中率：未知不猜数字，部分标注覆盖，旧数据保持原样', () => {
  assert.equal(cacheHitRateLabel(undefined, unknown), '未报告');
  assert.equal(cacheHitRateLabel(0.42, partial), '42%（部分）');
  assert.equal(cacheHitRateLabel(0.42, known), '42%');
  assert.equal(cacheHitRateLabel(0.42, undefined), '42%');
  assert.equal(cacheHitRateLabel(undefined, known), undefined);
  assert.equal(cacheHitRateLabel(undefined, undefined), undefined);
});
