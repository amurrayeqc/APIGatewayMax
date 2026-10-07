# RouteWeaver

[![CI](https://github.com/centxyz/RouteWeaver/actions/workflows/ci.yml/badge.svg)](https://github.com/centxyz/RouteWeaver/actions/workflows/ci.yml)

RouteWeaver is a configurable HTTP reverse proxy for routing requests across backend services. It provides longest-prefix matching, round-robin balancing, bounded retries, timeouts, circuit breakers, per-client rate limits, request IDs, and health metrics without requiring an external control plane.

## Features

- Longest-prefix route matching
- Multiple round-robin upstreams per route
- Optional route-prefix stripping
- GET/HEAD retry across alternate upstreams
- Upstream timeouts and circuit breakers
- Per-route, per-client fixed-window rate limits
- Request ID validation and propagation
- Streaming upstream responses
- Health and route-status endpoints
- JSON configuration with strict validation

## Install

```bash
git clone https://github.com/centxyz/RouteWeaver.git
cd RouteWeaver
npm install
npm test
```

Copy `gateway.example.json`, point its upstreams at your services, then run:

```bash
npm start -- --config gateway.example.json
```

The example listens on `127.0.0.1:8080`. Override it with `--host` or `--port`.

## Configuration

Each route supports:

- `prefix` — incoming path prefix
- `upstreams` — one or more HTTP(S) backend origins
- `stripPrefix` — remove the matched prefix before forwarding; default `true`
- `timeoutMs` — per-attempt timeout
- `retries` — alternate-upstream retries for GET/HEAD requests
- `failureThreshold` — failures before opening an upstream circuit
- `cooldownMs` — time before an open circuit is eligible again
- `rateLimit.max` and `rateLimit.windowMs` — per-client request limit

Non-idempotent methods are never automatically retried.

## Operations

- `GET /__gateway/health` — counters, routes, available upstreams, and open circuits
- `GET /__gateway/routes` — sanitized route availability

Every response includes `X-Request-ID`. A valid incoming ID is preserved; otherwise the gateway generates a UUID.

## Test

```bash
npm test
```

The suite verifies routing precedence, balancing, safe retries, circuit recovery, rate limiting, request IDs, query forwarding, and live proxying through real temporary HTTP servers.

## License

MIT © cent

## Current limitations

- Configuration is local and static; there is no distributed control plane or automatic service discovery.
- Rate limits and circuit-breaker state are process-local and are not shared across replicas.
- TLS termination, authentication, and edge DDoS protection must be provided separately.
