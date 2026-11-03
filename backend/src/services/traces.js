'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const db = require('../db');
const { chat } = require('./modelConfig');

const storage = new AsyncLocalStorage();
const MAX_EVENTS = 100;

function positiveInt(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function retention() {
  return {
    days: positiveInt(process.env.TRACE_RETENTION_DAYS, 7, 3650),
    maxPerBusiness: positiveInt(process.env.TRACE_MAX_PER_BUSINESS, 1000, 100000),
  };
}

function recordError(error, stageName = 'request') {
  const trace = storage.getStore();
  if (!trace || trace.errors.length >= MAX_EVENTS) return;
  trace.errors.push({ stage: stageName, message: String(error?.message || error).slice(0, 1000), code: error?.code || null });
}

function recordModel({ kind = 'chat', model, usage = null, latencyMs, error }) {
  const trace = storage.getStore();
  if (!trace) return;
  if (kind === 'chat') trace.model = model || trace.model;
  if (trace.token_usage.length < MAX_EVENTS) trace.token_usage.push({ kind, model, usage, latency_ms: Math.round(latencyMs || 0) });
  if (error) recordError(error, kind);
}

function recordContext(context) {
  const trace = storage.getStore();
  if (trace) trace.final_context = context;
}

function recordRetrieval(result) {
  const trace = storage.getStore();
  if (!trace || trace.retrievals.length >= MAX_EVENTS) return;
  trace.retrievals.push(result);
}

async function stage(name, fn, details) {
  const started = performance.now();
  try {
    return await fn();
  } catch (error) {
    recordError(error, name);
    throw error;
  } finally {
    const trace = storage.getStore();
    if (trace && trace.stages.length < MAX_EVENTS) trace.stages.push({ name, latency_ms: Math.round(performance.now() - started), ...(details ? { details } : {}) });
  }
}

async function runTrace(meta, fn, { save = db.saveRequestTrace, log = console.log } = {}) {
  const started = performance.now();
  const trace = {
    id: randomUUID(), business_id: meta.businessId, session_id: meta.sessionId,
    surface: meta.surface, query: meta.query, source: null, model: chat.model,
    token_usage: [], stages: [], retrievals: [], final_context: [], errors: [],
  };
  return storage.run(trace, async () => {
    try {
      const result = await fn(trace);
      trace.source = result?.source === 'agent' || result?.source === 'model' ? 'model'
        : result?.source === 'retriever-only' ? 'retriever' : result?.source || trace.source;
      return result;
    } catch (error) {
      trace.source = 'error';
      recordError(error);
      throw error;
    } finally {
      trace.duration_ms = Math.round(performance.now() - started);
      log(JSON.stringify({ event: 'rag.request', trace_id: trace.id, business_id: trace.business_id,
        surface: trace.surface, source: trace.source, model: trace.model,
        duration_ms: trace.duration_ms, retrieval_count: trace.retrievals.length, error_count: trace.errors.length }));
      try { await save(trace, retention()); }
      catch (error) { console.error(JSON.stringify({ event: 'rag.trace_write_failed', trace_id: trace.id, message: error.message })); }
    }
  });
}

module.exports = { runTrace, stage, recordError, recordModel, recordContext, recordRetrieval, retention, positiveInt };
