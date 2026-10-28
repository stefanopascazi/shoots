/** @jsxImportSource preact */
import { Alert, Button } from '@shoots/ui';
import type { LightroomError } from './contract.js';

/** A step that failed inside Lightroom: what, when, and where the plug-in logs it. */
export function LightroomErrorAlert({ error, onDismiss }: { error: LightroomError; onDismiss: () => void }) {
  return (
    <Alert
      tone="danger"
      title={`Lightroom could not complete: ${error.where}`}
      action={
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      {error.message} ({new Date(error.at).toLocaleTimeString()}). The plug-in log is in Documents › LrClassicLogs › shoots.log.
    </Alert>
  );
}
