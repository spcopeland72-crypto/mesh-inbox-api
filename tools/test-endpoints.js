/**
 * Test all mesh-inbox-api endpoints with real data.
 * Validates response bodies and data flow, not just HTTP 200.
 * Usage: node tools/test-endpoints.js [baseUrl]
 * Default: https://mesh-inbox-api.vercel.app
 * Env: MESH_INBOX_URL overrides baseUrl.
 */

const BASE = process.env.MESH_INBOX_URL || process.argv[2] || 'https://mesh-inbox-api.vercel.app';
const RUN_ID = Date.now();
const CONT_A = `TestContinuum_Alpha_${RUN_ID}`;
const CONT_B = `TestContinuum_Beta_${RUN_ID}`;

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` ${detail}` : ''}`);
  }
}

function fail(name, err, body) {
  failed++;
  console.log(`  ✗ ${name}`);
  if (err) console.log(`    Error: ${err.message || err}`);
  if (body != null) console.log(`    Body: ${JSON.stringify(body).slice(0, 200)}`);
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function getHtml(path) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url);
  const text = await res.text();
  const jsonMatch = text.match(/<pre id="newton-packet-out"[^>]*>([\s\S]*?)<\/pre>/);
  const body = jsonMatch ? (() => { try { return JSON.parse(jsonMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; } })() : null;
  return { status: res.status, text, body };
}

async function post(path, data) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function run() {
  console.log(`\nMesh Inbox API – data tests\nBase: ${BASE}\n`);

  // --- Clear test database ---
  console.log('0. Clear mesh inbox (fresh test data)');
  try {
    const clearRes = await post('/api/v1/inbox/test/clear', {});
    ok('clear status', clearRes.status === 200);
    ok('clear success', clearRes.body && clearRes.body.success === true);
  } catch (e) {
    fail('clear', e);
  }

  // --- Health ---
  console.log('1. Health');
  try {
    const { status, body } = await get('/health');
    ok('health status 200', status === 200);
    ok('health body.status', body && body.status === 'ok');
    ok('health body.service', body && body.service === 'Mesh Inbox API');
    ok('health body.redis', body && typeof body.redis === 'string');
    ok('health body.timestamp', body && body.timestamp);
    if (body && body.redis !== 'connected') {
      console.log(`    (Redis: ${body.redis} – some tests may fail without Redis)`);
    }
  } catch (e) {
    fail('health', e);
  }

  // --- Register ---
  console.log('\n2. Register continuums');
  try {
    const ra = await post('/api/v1/inbox/register', { continuumId: CONT_A });
    ok('register A status', ra.status === 200);
    if (ra.status !== 200) console.log(`    Register A response: ${ra.status} ${JSON.stringify(ra.body).slice(0, 200)}`);
    ok('register A success', ra.body && ra.body.success === true);
    ok('register A continuumId', ra.body && ra.body.continuumId === CONT_A);
    ok('register A status registered', ra.body && ra.body.status === 'registered');
    ok('register A registeredAt', ra.body && ra.body.registeredAt);

    const rb = await post('/api/v1/inbox/register', { continuumId: CONT_B });
    ok('register B status', rb.status === 200);
    ok('register B continuumId', rb.body && rb.body.continuumId === CONT_B);
  } catch (e) {
    fail('register', e);
  }

  // --- Discover ---
  console.log('\n3. Discover');
  try {
    const { status, body } = await get('/api/v1/inbox/discover');
    ok('discover status', status === 200);
    ok('discover success', body && body.success === true);
    ok('discover continuums array', body && Array.isArray(body.continuums));
    ok('discover total', body && typeof body.total === 'number');
    const ids = (body && body.continuums) ? body.continuums.map((c) => c.continuumId) : [];
    ok('discover contains A', ids.includes(CONT_A));
    ok('discover contains B', ids.includes(CONT_B));
    const bEntry = body && body.continuums && body.continuums.find((c) => c.continuumId === CONT_B);
    ok('discover B has last_heartbeat', bEntry && bEntry.last_heartbeat);
    ok('discover B has messages_sent/received', bEntry && typeof bEntry.messages_sent === 'number' && typeof bEntry.messages_received === 'number');
  } catch (e) {
    fail('discover', e);
  }

  // --- Send message ---
  console.log('\n4. Send message');
  const payload1 = { type: 'TEST_GREETING', text: 'Hello from Alpha', ts: Date.now() };
  let sentMessageId = null;
  try {
    const { status, body } = await post('/api/v1/inbox/send', {
      target: CONT_B,
      sender: CONT_A,
      payload: payload1,
      qos: 'Q2',
    });
    ok('send status', status === 200);
    ok('send success', body && body.success === true);
    ok('send status ENQUEUED', body && body.status === 'ENQUEUED');
    ok('send data.target', body && body.data && body.data.target === CONT_B);
    ok('send data.message_id', body && body.data && body.data.message_id && body.data.message_id.startsWith('msg_'));
    sentMessageId = body && body.data && body.data.message_id;
    ok('send data.qos', body && body.data && body.data.qos === 'Q2');
    ok('send data.timestamp', body && body.data && body.data.timestamp);
  } catch (e) {
    fail('send', e);
  }

  // --- Depth ---
  console.log('\n5. Queue depth');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}/depth`);
    ok('depth status', status === 200);
    ok('depth success', body && body.success === true);
    ok('depth continuumId', body && body.continuumId === CONT_B);
    ok('depth depth object', body && body.depth && typeof body.depth.Q0 === 'number' && typeof body.depth.Q2 === 'number');
    ok('depth Q2 >= 1 after send', body && body.depth && body.depth.Q2 >= 1);
  } catch (e) {
    fail('depth', e);
  }

  // --- Read next message ---
  console.log('\n6. Read next message');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}`);
    ok('read status', status === 200);
    ok('read success', body && body.success === true);
    ok('read message present', body && body.message != null && !body.empty);
    ok('read message.sender', body && body.message && body.message.sender === CONT_A);
    ok('read message.target', body && body.message && body.message.target === CONT_B);
    ok('read message.nme_version', body && body.message && body.message.nme_version === '3.0');
    ok('read message.qos', body && body.message && body.message.qos === 'Q2');
    ok('read message.payload', body && body.message && body.message.payload && body.message.payload.type === payload1.type && body.message.payload.text === payload1.text);
    ok('read message_id matches send', body && body.message && body.message.message_id === sentMessageId);
  } catch (e) {
    fail('read', e);
  }

  // --- Read second message (from NQP) ---
  console.log('\n6b. Read second message (from NQP)');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}`);
    ok('read second status', status === 200);
    ok('read second message present', body && body.message != null && !body.empty);
    ok('read second message.sender', body && body.message && body.message.sender === CONT_A);
    ok('read second message.payload.nqp', body && body.message && body.message.payload && body.message.payload.nqp === true);
  } catch (e) {
    fail('read second (NQP)', e);
  }

  // --- Read empty ---
  console.log('\n7. Read (empty)');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}`);
    ok('read empty status', status === 200);
    ok('read empty empty', body && body.empty === true);
    ok('read empty message null', body && body.message == null);
  } catch (e) {
    fail('read empty', e);
  }

  // --- Priority read (no Q0) ---
  console.log('\n8. Priority read (no Q0)');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}/priority`);
    ok('priority empty status', status === 200);
    ok('priority empty', body && body.empty === true && body.message == null);
  } catch (e) {
    fail('priority empty', e);
  }

  // --- Send Q0 then priority read ---
  console.log('\n9. Send Q0 and priority read');
  const payloadQ0 = { type: 'CRITICAL', code: 999 };
  try {
    const sendRes = await post('/api/v1/inbox/send', { target: CONT_B, sender: CONT_A, payload: payloadQ0, qos: 'Q0' });
    ok('send Q0', sendRes.status === 200 && sendRes.body && sendRes.body.success);
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}/priority`);
    ok('priority read status', status === 200);
    ok('priority read message', body && body.message != null && !body.empty);
    ok('priority read message.qos Q0', body && body.message && body.message.qos === 'Q0');
    ok('priority read payload', body && body.message && body.message.payload && body.message.payload.type === payloadQ0.type);
  } catch (e) {
    fail('send Q0 / priority read', e);
  }

  // --- Continuum stats ---
  console.log('\n10. Continuum stats');
  try {
    const { status, body } = await get(`/api/v1/inbox/${CONT_B}/stats`);
    ok('stats status', status === 200);
    ok('stats success', body && body.success === true);
    ok('stats continuumId', body && body.continuumId === CONT_B);
    ok('stats stats object', body && body.stats != null);
    ok('stats messages_sent', body && body.stats && typeof body.stats.messages_sent === 'number');
    ok('stats messages_received', body && body.stats && typeof body.stats.messages_received === 'number');
    ok('stats last_heartbeat', body && body.stats && 'last_heartbeat' in body.stats);
    ok('stats status field', body && body.stats && typeof body.stats.status === 'string');
  } catch (e) {
    fail('stats', e);
  }

  // --- List continuums ---
  console.log('\n11. List continuum IDs');
  try {
    const { status, body } = await get('/api/v1/inbox/continuums');
    ok('continuums status', status === 200);
    ok('continuums success', body && body.success === true);
    const list = (body && body.continuums) || [];
    ok('continuums array', Array.isArray(list));
    ok('continuums contains A', list.includes(CONT_A));
    ok('continuums contains B', list.includes(CONT_B));
  } catch (e) {
    fail('continuums', e);
  }

  // --- Send 400 (missing target) ---
  console.log('\n12. Send 400 (missing target)');
  try {
    const { status, body } = await post('/api/v1/inbox/send', { sender: CONT_A, payload: {} });
    ok('send 400 status', status === 400);
    ok('send 400 success false', body && body.success === false);
    ok('send 400 error message', body && body.error && typeof body.error === 'string');
  } catch (e) {
    fail('send 400', e);
  }

  // --- Root GET / ---
  console.log('\n13. Root GET /');
  try {
    const { status, body } = await get('/');
    ok('root status', status === 200);
    ok('root service', body && body.service === 'Mesh Inbox API');
    ok('root endpoints', body && body.endpoints && typeof body.endpoints.health === 'string');
    ok('root endpoints.nqp', body && body.endpoints && body.endpoints.nqp);
  } catch (e) {
    fail('root', e);
  }

  // --- GET /nqp compact (c=MD&to=&from=&pl=) ---
  console.log('\n14. GET /nqp compact send');
  const compactPayload = encodeURIComponent(JSON.stringify({ text: 'CompactHello' }));
  try {
    const res = await fetch(`${BASE}/nqp?c=MD&to=${encodeURIComponent(CONT_B)}&from=${encodeURIComponent(CONT_A)}&pl=${compactPayload}`);
    const body = await res.json().catch(() => null);
    ok('nqp GET status', res.status === 200);
    ok('nqp GET success', body && body.success === true);
    ok('nqp GET data.target', body && body.data && body.data.target === CONT_B);
    const readRes = await get(`/api/v1/inbox/${CONT_B}`);
    ok('nqp GET message received', readRes.body && readRes.body.message && (readRes.body.message.payload?.text === 'CompactHello' || (readRes.body.message.payload && readRes.body.message.payload.text === 'CompactHello')));
  } catch (e) {
    fail('GET /nqp compact', e);
  }

  // --- Substrate path aliases ---
  console.log('\n15. Substrate alias GET /register/:continuumId');
  try {
    const { status, body } = await get(`/register/${CONT_A}`);
    ok('alias register status', status === 200);
    ok('alias register success', body && body.success === true);
    ok('alias register continuumId', body && body.continuumId === CONT_A);
  } catch (e) {
    fail('alias register', e);
  }

  console.log('\n16. Substrate alias GET /discover');
  try {
    const { status, body } = await get('/discover');
    ok('alias discover status', status === 200);
    ok('alias discover success', body && body.success === true);
    ok('alias discover continuums array', body && Array.isArray(body.continuums));
  } catch (e) {
    fail('alias discover', e);
  }

  console.log('\n17. Substrate alias GET /:continuumId (read)');
  try {
    const { status, body } = await get(`/${CONT_B}`);
    ok('alias read status', status === 200);
    ok('alias read success', body && body.success === true);
    ok('alias read empty (already read)', body && body.empty === true);
  } catch (e) {
    fail('alias read', e);
  }

  console.log('\n18. Substrate alias GET /priority/:continuumId');
  try {
    const { status, body } = await get(`/priority/${CONT_B}`);
    ok('alias priority status', status === 200);
    ok('alias priority success', body && body.success === true);
  } catch (e) {
    fail('alias priority', e);
  }

  // --- HTML response (?format=html) ---
  console.log('\n19. HTML response GET /health?format=html');
  try {
    const { status, text, body } = await getHtml('/health?format=html');
    ok('health HTML status', status === 200);
    ok('health HTML has newton-packet-out', text && text.includes('newton-packet-out'));
    ok('health HTML parsed body.status', body && body.status === 'ok');
  } catch (e) {
    fail('health HTML', e);
  }

  // --- Search (web search DSL) ---
  console.log('\n20. Search SYS.HEALTH');
  try {
    const res = await fetch(`${BASE}/search?q=mesh-inbox%20%22SYS.HEALTH%22%20%22%22&format=json`);
    const body = await res.json().catch(() => null);
    ok('search health status', res.status === 200);
    ok('search health command', body && (body.command === 'SYS.HEALTH' || body.data?.status === 'ok'));
    ok('search health data', body && body.data);
  } catch (e) {
    fail('search SYS.HEALTH', e);
  }

  console.log('\n21. Search MESH.DISPATCH (write)');
  try {
    const q = encodeURIComponent(`mesh-inbox "MESH.DISPATCH" "to:${CONT_B} from:${CONT_A} message:SearchTest"`);
    const res = await fetch(`${BASE}/search?q=${q}&format=json`);
    const body = await res.json().catch(() => null);
    ok('search dispatch status', res.status === 200);
    ok('search dispatch executed', body && (body.status === 'executed' || body.data?.success === true));
  } catch (e) {
    fail('search MESH.DISPATCH', e);
  }

  console.log('\n22. Search MESH.POLL (read)');
  try {
    const q = encodeURIComponent(`mesh-inbox "MESH.POLL" "continuum_id:${CONT_B}"`);
    const res = await fetch(`${BASE}/search?q=${q}&format=json`);
    const body = await res.json().catch(() => null);
    ok('search poll status', res.status === 200);
    ok('search poll executed', body && body.status === 'executed');
    ok('search poll data', body && body.data);
  } catch (e) {
    fail('search MESH.POLL', e);
  }

  // --- Summary ---
  console.log('\n---');
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
