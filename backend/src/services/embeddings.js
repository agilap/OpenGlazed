'use strict';

const { embedTexts, embedQuery } = require('./llm');
const { embed: embedCfg } = require('./modelConfig');

module.exports = { embedTexts, embedQuery, EMBED_DIM: embedCfg.dim, EMBED_MODEL: embedCfg.model };
