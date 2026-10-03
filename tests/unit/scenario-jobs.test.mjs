/*
 * Copyright (c) 2026 Terry Packer.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * scenario-jobs.test.mjs — design 116 phase 2: authoring `cfg.jobs`, and the person
 * levers a job supersedes.
 *
 *   SJ-1: replacePersonJobs assigns stable ids and leaves other people's jobs alone
 *   SJ-2: an overlapping edit is refused and nothing is committed
 *   SJ-3: deleting a person's jobs drops the key when none are left
 *   SJ-4: a person with jobs generates no monthlyWage / retirementDate lever
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  listPersonJobs, replacePersonJobs, deletePersonJobs, nextJobId,
} from '../../src/scenarios/scenario-jobs.js';
import { ScenarioParamGenerator } from '../../src/scenarios/params/scenario-param-generator.js';

test('SJ-1: ids are assigned once and other people are untouched', () => {
  const scenario = { jobs: [{ id: 'spouse-job-1', personId: 'spouse', monthlyWage: 1 }] };
  replacePersonJobs(scenario, 'primary', [
    { monthlyWage: 5000, endDate: '2031-07-01' },
    { monthlyWage: 6000, startDate: '2031-07-01' },
  ]);
  assert.deepEqual(listPersonJobs(scenario, 'primary').map(j => j.id),
                   ['primary-job-1', 'primary-job-2']);
  assert.equal(listPersonJobs(scenario, 'spouse').length, 1);
  const before = scenario.jobs;
  replacePersonJobs(scenario, 'primary', listPersonJobs(scenario, 'primary'));
  assert.notEqual(scenario.jobs, before, 'the list is replaced, never mutated in place');
  assert.deepEqual(listPersonJobs(scenario, 'primary').map(j => j.id),
                   ['primary-job-1', 'primary-job-2'], 'existing ids are kept');
  assert.equal(nextJobId('primary', ['primary-job-1']), 'primary-job-2');
});

test('SJ-2: an overlapping edit throws and commits nothing', () => {
  const scenario = { jobs: [] };
  assert.throws(() => replacePersonJobs(scenario, 'primary', [
    { monthlyWage: 1, endDate: '2032-01-01' },
    { monthlyWage: 1, startDate: '2031-01-01' },
  ]), /overlap/);
  assert.deepEqual(scenario.jobs, []);
});

test('SJ-3: deleting the last jobs removes the key', () => {
  const scenario = { jobs: [{ id: 'j', personId: 'primary', monthlyWage: 1 }] };
  deletePersonJobs(scenario, 'primary');
  assert.ok(!('jobs' in scenario));
  deletePersonJobs(scenario, 'primary');   // a no-op, not a throw
});

test('SJ-4: a person with jobs generates no flat wage or retire-date lever', () => {
  const cfg = {
    persons: [{ id: 'primary', name: 'P', monthlyWage: 8000, retirementDate: '2040-01-01' },
              { id: 'spouse',  name: 'S', monthlyWage: 4000, retirementDate: '2040-01-01' }],
    jobs: [{ id: 'primary-job-1', personId: 'primary', monthlyWage: 9000 }],
  };
  const keys = new Set(ScenarioParamGenerator.generate(cfg).map(e => e.key));
  assert.ok(!keys.has('person.primary.monthlyWage'));
  assert.ok(!keys.has('person.primary.retirementDate'));
  assert.ok(keys.has('person.primary.ssClaimAge'), 'the rest of the person is unchanged');
  assert.ok(keys.has('person.spouse.monthlyWage'), 'a legacy person keeps the lever');
});
