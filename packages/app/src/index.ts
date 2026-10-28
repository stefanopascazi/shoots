/**
 * Server-side entry of @shoots/app: the API contract and the rules shared with
 * the page. The built page itself is `@shoots/app/page` (see page.d.ts).
 */
export type * from './contract.js';
export {
  applyMarksPatch,
  changeFor,
  COLOR_LABELS,
  FLAGS,
  PICK_OF,
  RESET_PARTS,
  sameChange,
  sanitizeMarksPatch,
  sendStatus,
} from './outbox.js';
export type { LightroomChange, PickStatus, SendState, SendStatus, SentChange } from './outbox.js';
