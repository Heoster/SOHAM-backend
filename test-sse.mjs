/**
 * SSE smoke test with verbose server-side logging.
 * Run: node test-sse.mjs
 */
import http from 'http';

const body = JSON.stringify({
  message: 'say hi in one word',
  history: [],
  settings: { model: 'auto', tone: 'helpful', technicalLevel: 'intermediate' },
});

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/api/chat/stream',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer soham-secret-key-2025',
    'Content-Length': Buffer.byteLength(body),
  },
};

console.log('Connecting to SSE stream...\n');
const startTime = Date.now();

const req = http.request(options, (res) => {
  console.log(`Status: ${res.statusCode}`);
  console.log(`Content-Type: ${res.headers['content-type']}\n`);

  let buffer = '';
  let tokenCount = 0;
  let fullText = '';

  res.on('data', (chunk) => {
    const raw = chunk.toString();
    // Log any non-data lines for debugging
    raw.split('\n').forEach(line => {
      if (line && !line.startsWith('data: ') && !line.startsWith(': ') && line.trim()) {
        console.log('[RAW]', JSON.stringify(line));
      }
    });

    buffer += raw;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith(': ')) continue; // SSE heartbeat comment
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        switch (event.type) {
          case 'status':
            console.log(`[${elapsed}s] STATUS: ${event.text}`);
            break;
          case 'token':
            tokenCount++;
            fullText += event.text;
            if (tokenCount <= 5) {
              process.stdout.write(`[${elapsed}s] TOKEN: "${event.text}"\n`);
            } else {
              process.stdout.write('.');
            }
            break;
          case 'image':
            console.log(`\n[${elapsed}s] IMAGE: ${event.url}`);
            break;
          case 'done':
            console.log(`\n\n[${elapsed}s] DONE`);
            console.log(`  Model: ${event.modelUsed}`);
            console.log(`  AutoRouted: ${event.autoRouted}`);
            console.log(`  ResponseTime: ${event.responseTime}`);
            console.log(`  Tokens received: ${tokenCount}`);
            console.log(`  Full text: "${fullText.trim()}"`);
            break;
          case 'error':
            console.log(`\n[${elapsed}s] ERROR: ${event.text}`);
            break;
          default:
            console.log(`\n[${elapsed}s] UNKNOWN: ${JSON.stringify(event)}`);
        }
      } catch {
        // skip malformed
      }
    }
  });

  res.on('end', () => {
    console.log(`\n\nStream ended. Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    if (tokenCount === 0 && !fullText) {
      console.log('WARNING: No tokens received — stream may have failed silently');
    }
    process.exit(0);
  });

  res.on('error', (err) => {
    console.error('Response stream error:', err.message);
    process.exit(1);
  });
});

req.on('error', (err) => {
  console.error('Request error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('\nTest timed out after 45s');
  req.destroy();
  process.exit(1);
}, 45000);

req.write(body);
req.end();
