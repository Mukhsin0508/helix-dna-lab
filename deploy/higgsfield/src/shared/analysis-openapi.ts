const string = { type: 'string' };
const record = { $ref: '#/components/schemas/Analysis' };
const response = { description: 'Persisted dataset and figure settings.', content: { 'application/json': { schema: { type: 'object', required: ['analysis'], properties: { analysis: record } } } } };
const errors = {
  '400': { description: 'Invalid dataset, coordinates, figure settings or JSON.' },
  '404': { description: 'Analysis does not exist.' },
  '409': { description: 'Revision conflict. Response includes latest analysis; preserve local edits.' },
  '413': { description: 'Request exceeds 2 MiB.' },
  '429': { description: 'Request budget exceeded; retry later.' },
};
const body = (name: string) => ({ required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } });

export const analysisPaths = {
  '/api/analyses': { post: { operationId: 'createAnalysis', summary: 'Save imported scores or genomic tracks with a figure recipe',
    description: 'Stores supplied numerical results without running inference. Anyone with the returned link can view and edit it. Do not upload private genomic data.',
    requestBody: body('AnalysisInput'), responses: { '201': response, ...errors } } },
  '/api/analyses/{id}': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    get: { operationId: 'getAnalysis', summary: 'Read a saved analysis', responses: { '200': response, ...errors } },
    patch: { operationId: 'updateAnalysis', summary: 'Save a complete replacement at the expected revision',
      requestBody: body('AnalysisPatch'), responses: { '200': response, ...errors } },
  },
};
export const analysisSchemas = {
  AnalysisProvenance: { type: 'object', additionalProperties: false,
    required: ['sourceUrl', 'sourceLabel', 'assembly', 'model', 'context', 'mode'],
    properties: { sourceUrl: { ...string, description: 'HTTP(S) source URL, or empty for user imports.' }, sourceLabel: string,
      assembly: { ...string, description: 'Explicit genome assembly. Variant syntax checks are not reference-allele validation.' }, model: string, context: string,
      recordedAt: { type: 'string', format: 'date-time' }, mode: { enum: ['published-example', 'imported'] } } },
  AnalysisScoreRow: { type: 'object', required: ['variant', 'biosample', 'modality', 'scorer', 'score'],
    properties: { variant: { ...string, description: 'Human primary-chromosome SNV, one-based: chr9:128226027:G>A.' }, biosample: string,
      modality: string, scorer: string, score: { type: 'number', description: 'Finite raw molecular-effect score, in scorer-specific units.' },
      quantile: { type: 'number', minimum: -1, maximum: 1, description: 'May be signed. Not a clinical probability or AVI PHRED.' },
      gene: string, track: string, unit: string, signed: { type: 'boolean' }, trackStrand: { enum: ['+', '-', '.'] },
      assay: string, sourceRowIndex: { type: 'integer', minimum: 0 }, scoredInterval: string, geneId: string, geneStrand: { enum: ['+', '-', '.'] }, histoneMark: string },
    additionalProperties: false },
  AnalysisTrackRow: { type: 'object', additionalProperties: false, required: ['chromosome', 'position', 'reference', 'alternate', 'track'],
    properties: { chromosome: { ...string, description: 'Primary human chromosome, e.g. chr9.' },
      position: { type: 'integer', minimum: 0, description: 'Zero-based genomic coordinate. Must be unique per chromosome and track.' },
      reference: { type: 'number', description: 'Reference signal value.' }, alternate: { type: 'number', description: 'Alternate signal value.' }, track: string } },
  AnalysisDataset: { oneOf: ['scores', 'tracks'].map(kind => ({ type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'id', 'title', 'kind', 'provenance', 'rows'],
    properties: { schemaVersion: { const: 1 }, id: string, title: string, kind: { const: kind },
      provenance: { $ref: '#/components/schemas/AnalysisProvenance' },
      rows: { type: 'array', minItems: 1, maxItems: 5000, items: { $ref: `#/components/schemas/Analysis${kind === 'scores' ? 'Score' : 'Track'}Row` } } } })) },
  FigureSettings: { type: 'object', additionalProperties: false,
    required: ['chart', 'title', 'modality', 'scorer', 'track', 'gene', 'metric', 'limit', 'variant'],
    properties: { chart: { enum: ['bars', 'heatmap', 'tracks', 'table'] }, title: string, modality: string, scorer: string, track: string,
      gene: string, metric: { enum: ['score', 'quantile'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }, variant: string } },
  AnalysisInput: { type: 'object', additionalProperties: false, required: ['dataset', 'settings'], properties: {
    dataset: { $ref: '#/components/schemas/AnalysisDataset' }, settings: { $ref: '#/components/schemas/FigureSettings' } } },
  AnalysisPatch: { type: 'object', additionalProperties: false, required: ['revision', 'dataset', 'settings'], properties: {
    revision: { type: 'integer', minimum: 0 }, dataset: { $ref: '#/components/schemas/AnalysisDataset' }, settings: { $ref: '#/components/schemas/FigureSettings' } } },
  Analysis: { type: 'object', required: ['id', 'revision', 'dataset', 'settings', 'createdAt', 'updatedAt'], properties: {
    id: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 0 }, dataset: { $ref: '#/components/schemas/AnalysisDataset' },
    settings: { $ref: '#/components/schemas/FigureSettings' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
};
