/**
 * @shoots/match — pairwise preference learning.
 *
 * `shoots embeddings` extracts the features; this package turns duels over them
 * into a rating profile that generalizes one photographer's eye. It deliberately
 * has no dependency on @shoots/inference: no CLIP, no onnxruntime, nothing but
 * numbers that were handed to it.
 */
export { runImport, type ImportArgs, type ImportResult } from './api/import.js';
export { runServe, type ServeArgs, type ServeResult } from './api/serve.js';
export { runTrain, MIN_DUELS, type TrainArgs, type TrainResult } from './api/train.js';
export { sqliteDriver } from './db/database.js';
export type { Dataset, DatasetResult, LinearEmbeddingProfile, PhotoRow } from './types.js';
