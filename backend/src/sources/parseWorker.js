'use strict';

// Runs one PDF/DOCX parse off the main thread so a hostile file cannot stall the server.
const { parentPort, workerData } = require('node:worker_threads');
const parsers = { pdf: require('./pdf'), docx: require('./docx') };

const { sourceType, data, filename } = workerData;
parsers[sourceType].parse({ data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), filename })
  .then((sections) => parentPort.postMessage({ sections }), (error) => parentPort.postMessage({ error: String(error.message || error) }));
