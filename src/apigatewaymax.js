const crypto = require('node:crypto');

class GatewayError extends Error {
    constructor(message, statusCode = 400) { super(message); this.name = 'GatewayError'; this.statusCode = statusCode; }
}

class APIGatewayMax {
    constructor(config = {}, options = {}) {
        this.fetch = options.fetch || global.fetch;
        this.now = options.now || Date.now;
        this.routes = validateRoutes(config.routes || []);
        this.counters = new Map();
        this.circuits = new Map();
        this.rateBuckets = new Map();
        this.metrics = { requests: 0, proxied: 0, failed: 0, rateLimited: 0, unavailable: 0 };
    }

    match(pathname) {
        return this.routes.find(route => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) || null;
    }

    async proxy(request) {
        const route = this.match(request.pathname);
        if (!route) throw new GatewayError('No gateway route matches this path', 404);
        this.metrics.requests += 1;
        this.enforceRateLimit(route, request.clientId || 'anonymous');
        const candidates = this.availableUpstreams(route);
        if (!candidates.length) { this.metrics.unavailable += 1; throw new GatewayError('All upstreams are temporarily unavailable', 503); }

        const start = this.counters.get(route.prefix) || 0;
        this.counters.set(route.prefix, start + 1);
        const ordered = [...candidates.slice(start % candidates.length), ...candidates.slice(0, start % candidates.length)];
        const attempts = request.method === 'GET' || request.method === 'HEAD' ? Math.min(route.retries + 1, ordered.length) : 1;
        let lastError;
        for (let index = 0; index < attempts; index += 1) {
            const upstream = ordered[index];
            try {
                const response = await this.forward(route, upstream, request);
                if (response.status >= 500) {
                    await response.body?.cancel();
                    throw new GatewayError(`Upstream returned HTTP ${response.status}`, 502);
                }
                this.recordSuccess(upstream);
                this.metrics.proxied += 1;
                return { response, upstream };
            } catch (error) {
                lastError = error;
                this.recordFailure(route, upstream);
            }
        }
        this.metrics.failed += 1;
        throw new GatewayError(lastError?.message || 'Upstream request failed', 502);
    }

    async forward(route, upstream, request) {
        let suffix = request.pathname;
        if (route.stripPrefix) suffix = suffix.slice(route.prefix.length) || '/';
        const url = new URL(`${suffix}${request.search || ''}`, upstream.endsWith('/') ? upstream : `${upstream}/`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), route.timeoutMs);
        const headers = { ...request.headers, host: undefined, connection: undefined, 'content-length': undefined, 'x-request-id': request.requestId };
        for (const key of Object.keys(headers)) if (headers[key] == null) delete headers[key];
        try {
            return await this.fetch(url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, signal: controller.signal, redirect: 'manual' });
        } catch (error) {
            if (error.name === 'AbortError') throw new GatewayError('Upstream request timed out', 504);
            throw new GatewayError(`Upstream request failed: ${error.message}`, 502);
        } finally { clearTimeout(timeout); }
    }

    availableUpstreams(route) {
        const now = this.now();
        return route.upstreams.filter(upstream => {
            const circuit = this.circuits.get(upstream);
            if (!circuit || circuit.openUntil <= now) return true;
            return false;
        });
    }

    recordSuccess(upstream) { this.circuits.set(upstream, { failures: 0, openUntil: 0 }); }
    recordFailure(route, upstream) {
        const current = this.circuits.get(upstream) || { failures: 0, openUntil: 0 };
        current.failures += 1;
        if (current.failures >= route.failureThreshold) current.openUntil = this.now() + route.cooldownMs;
        this.circuits.set(upstream, current);
    }

    enforceRateLimit(route, clientId) {
        if (!route.rateLimit) return;
        const key = `${route.prefix}:${clientId}`;
        const now = this.now();
        let bucket = this.rateBuckets.get(key);
        if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + route.rateLimit.windowMs };
        bucket.count += 1;
        this.rateBuckets.set(key, bucket);
        if (bucket.count > route.rateLimit.max) { this.metrics.rateLimited += 1; throw new GatewayError('Rate limit exceeded', 429); }
    }

    status() {
        return {
            ...this.metrics,
            routes: this.routes.map(route => ({ prefix: route.prefix, upstreams: route.upstreams.length, available: this.availableUpstreams(route).length })),
            openCircuits: [...this.circuits.values()].filter(item => item.openUntil > this.now()).length
        };
    }

    static requestId(value) { return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : crypto.randomUUID(); }
}

function validateRoutes(routes) {
    if (!Array.isArray(routes) || !routes.length) throw new GatewayError('At least one route is required');
    const prefixes = new Set();
    return routes.map((input, index) => {
        if (!input || typeof input !== 'object') throw new GatewayError(`routes[${index}] must be an object`);
        const prefix = input.prefix;
        if (typeof prefix !== 'string' || !prefix.startsWith('/') || prefix.endsWith('/') && prefix !== '/') throw new GatewayError(`routes[${index}].prefix is invalid`);
        if (prefixes.has(prefix)) throw new GatewayError(`Duplicate route prefix: ${prefix}`);
        prefixes.add(prefix);
        if (!Array.isArray(input.upstreams) || !input.upstreams.length) throw new GatewayError(`routes[${index}].upstreams must not be empty`);
        const upstreams = input.upstreams.map(value => {
            let url; try { url = new URL(value); } catch { throw new GatewayError(`Invalid upstream URL: ${value}`); }
            if (!['http:', 'https:'].includes(url.protocol)) throw new GatewayError(`Unsupported upstream protocol: ${url.protocol}`);
            return url.toString();
        });
        const rateLimit = input.rateLimit ? { max: integer(input.rateLimit.max, 100, 1, 100000, 'rateLimit.max'), windowMs: integer(input.rateLimit.windowMs, 60000, 100, 3600000, 'rateLimit.windowMs') } : null;
        return { prefix, upstreams, stripPrefix: input.stripPrefix !== false, timeoutMs: integer(input.timeoutMs, 5000, 100, 60000, 'timeoutMs'), retries: integer(input.retries, 1, 0, 10, 'retries'), failureThreshold: integer(input.failureThreshold, 3, 1, 100, 'failureThreshold'), cooldownMs: integer(input.cooldownMs, 30000, 100, 3600000, 'cooldownMs'), rateLimit };
    }).sort((a, b) => b.prefix.length - a.prefix.length);
}

function integer(value, fallback, min, max, name) { const parsed = value == null ? fallback : Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new GatewayError(`${name} must be an integer from ${min} to ${max}`); return parsed; }

module.exports = { APIGatewayMax, GatewayError };
