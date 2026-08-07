/**
 * A stand-in for `exiftool -stay_open True -@ -`, so the daemon's wire protocol
 * can be tested without a provisioned binary (and without minutes of real
 * metadata work). It reproduces exactly what the real one does, verified
 * against exiftool 13.59:
 *
 *   stdout   <payload><marker>\r\n              — no newline before the marker
 *   stderr   <messages><marker>:<status>\r\n    — via -echo4, messages first
 *
 * Behaviour is chosen by the first argument of a batch, so a test asks for the
 * shape it wants rather than for a particular file.
 */
import { Buffer } from 'node:buffer';

const args = [];
let carry = '';

process.stdin.on('data', (chunk) => {
  carry += chunk.toString('latin1');
  let nl;
  while ((nl = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, nl).replace(/\r$/, '');
    carry = carry.slice(nl + 1);
    handle(line);
  }
});

let echo4 = null;

function handle(line) {
  if (echo4 === '') {
    echo4 = line;
    return;
  }
  if (line === '-echo4') {
    echo4 = '';
    return;
  }
  const execute = /^-execute(\d+)$/.exec(line);
  if (execute) {
    flush(execute[1]);
    return;
  }
  if (line === '-stay_open') return;
  if (line === 'False') {
    process.exit(0);
  }
  args.push(line);
}

/** Every byte value, so a binary payload proves it survived unmangled. */
function allBytes() {
  return Buffer.from(Array.from({ length: 256 }, (_, i) => i));
}

function flush(id) {
  const batch = args.splice(0, args.length);
  const marker = echo4 ?? `{ready${id}:\${status}}`;
  echo4 = null;

  let payload = Buffer.alloc(0);
  let message = '';
  let status = 0;

  switch (batch[0]) {
    case '-ver':
      payload = Buffer.from('13.59\r\n', 'latin1');
      break;
    case '-bin':
      // -b output: raw bytes, no trailing newline.
      payload = allBytes();
      break;
    case '-fail':
      message = 'Error: File not found - nope.cr3\r\n';
      status = 1;
      break;
    case '-partial':
      // What a mixed batch looks like: some files read, some did not.
      payload = Buffer.from('partial\r\n', 'latin1');
      message = 'Error: File not found - nope.cr3\r\n';
      status = 1;
      break;
    case '-crash':
      process.exit(3);
      break;
    case '-echoargs':
      payload = Buffer.from(batch.slice(1).join('|'), 'latin1');
      break;
    case '-big':
      // Large enough to cross the pipe's chunk size many times over, which is
      // what a full-size embedded RAW preview does.
      payload = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      break;
    case '-splitmarker': {
      // The marker arriving one byte per 'data' event, which is the case that
      // hung: a reader carrying over only the last chunk's bytes loses the
      // earlier ones as soon as a chunk is shorter than a marker, and never
      // matches. The gaps are load-bearing — without them the runtime coalesces
      // these writes into a single chunk and the test proves nothing.
      const pieces = `{ready${id}}\r\n`.split('');
      process.stdout.write('split\r\n');
      let i = 0;
      const tick = () => {
        if (i < pieces.length) {
          process.stdout.write(pieces[i++]);
          setTimeout(tick, 12);
          return;
        }
        process.stderr.write(marker.replace('${status}', '0') + '\r\n');
      };
      setTimeout(tick, 12);
      return;
    }
    default:
      payload = Buffer.from(batch.join(' ') + '\r\n', 'latin1');
  }

  const emit = () => {
    process.stdout.write(payload);
    process.stdout.write(`{ready${id}}\r\n`);
    process.stderr.write(message + marker.replace('${status}', String(status)) + '\r\n');
  };
  // `-slow` anywhere in the batch defers the answer, so a test can prove the
  // daemon serializes rather than interleaving two replies.
  if (batch.includes('-slow')) setTimeout(emit, 120);
  else emit();
}
