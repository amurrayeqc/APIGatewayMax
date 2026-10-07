const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { APIGatewayMax, GatewayError } = require('../src/apigatewaymax');
const { createServer } = require('../src/index');

const baseConfig = { routes: [{ prefix: '/api', upstreams: ['https://one.test', 'https://two.test'], stripPrefix: true, retries: 1 }] };

describe('APIGatewayMax', () => {
    test('uses longest-prefix routing and round-robin balancing', async () => {
        const seen = [];
        const gateway = new APIGatewayMax({ routes: [
            ...baseConfig.routes,
            { prefix: '/api/admin', upstreams: ['https://admin.test'] }
        ] }, { fetch: async url => { seen.push(url.toString()); return new Response('ok'); } });
        await gateway.proxy(request('/api/admin/users'));
        await gateway.proxy(request('/api/items'));
        await gateway.proxy(request('/api/items'));
        assert.deepEqual(seen, ['https://admin.test/users', 'https://one.test/items', 'https://two.test/items']);
    });

    test('retries safe requests on another upstream', async () => {
        let calls = 0;
        const gateway = new APIGatewayMax(baseConfig, { fetch: async () => { calls += 1; if (calls === 1) throw new Error('offline'); return new Response('recovered'); } });
        const result = await gateway.proxy(request('/api/data'));
        assert.equal(await result.response.text(), 'recovered');
        assert.equal(calls, 2);
    });

    test('does not retry non-idempotent requests', async () => {
        let calls = 0;
        const gateway = new APIGatewayMax(baseConfig, { fetch: async () => { calls += 1; throw new Error('offline'); } });
        await assert.rejects(() => gateway.proxy(request('/api/data', 'POST')), GatewayError);
        assert.equal(calls, 1);
    });

    test('opens circuits after repeated upstream failures', async () => {
        let now = 1000;
        const gateway = new APIGatewayMax({ routes: [{ prefix: '/api', upstreams: ['https://one.test'], retries: 0, failureThreshold: 2, cooldownMs: 500 }] }, { now: () => now, fetch: async () => { throw new Error('offline'); } });
        await assert.rejects(() => gateway.proxy(request('/api/a')));
        await assert.rejects(() => gateway.proxy(request('/api/a')));
        assert.equal(gateway.status().openCircuits, 1);
        await assert.rejects(() => gateway.proxy(request('/api/a')), /temporarily unavailable/);
        now += 501;
        assert.equal(gateway.status().routes[0].available, 1);
    });

    test('enforces per-client route rate limits', async () => {
        const gateway = new APIGatewayMax({ routes: [{ prefix: '/api', upstreams: ['https://one.test'], rateLimit: { max: 2, windowMs: 1000 } }] }, { fetch: async () => new Response('ok') });
        await gateway.proxy(request('/api/a'));
        await gateway.proxy(request('/api/a'));
        await assert.rejects(() => gateway.proxy(request('/api/a')), error => error.statusCode === 429);
    });

    test('proxies through a live HTTP gateway and reports health', async () => {
        const upstream = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, requestId: req.headers['x-request-id'] })); });
        await listen(upstream);
        const gateway = new APIGatewayMax({ routes: [{ prefix: '/api', upstreams: [`http://127.0.0.1:${upstream.address().port}`] }] });
        const server = createServer(gateway);
        await listen(server);
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users?active=1`);
            const body = await response.json();
            assert.equal(body.path, '/users?active=1');
            assert.equal(body.requestId, response.headers.get('x-request-id'));
            const health = await fetch(`http://127.0.0.1:${server.address().port}/__gateway/health`).then(value => value.json());
            assert.equal(health.status, 'healthy');
            assert.equal(health.proxied, 1);
        } finally { await close(server); await close(upstream); }
    });
});

function request(pathname, method = 'GET') { return { pathname, search: '', method, headers: {}, body: method === 'POST' ? Buffer.from('{}') : undefined, clientId: 'test', requestId: 'request-test' }; }
function listen(server) { return new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve)); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
