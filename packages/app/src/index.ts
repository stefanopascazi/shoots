/**
 * Server-side entry of @shoots/app: the API contract, the rules shared with the
 * page, and the built page. APP_HTML lives in dist/index.js, written by
 * build.ts; this file only types it.
 */
export declare const APP_HTML: string;
export type * from './contract.js';
export { changeFor, sameChange, sendStatus } from './outbox.js';
export type { LightroomChange, PickStatus, SendState, SendStatus, SentChange } from './outbox.js';
