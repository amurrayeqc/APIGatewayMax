#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const minimist = require('minimist');
const { Readable } = require('node:stream');
const { APIGatewayMax } = require('./apigatewaymax');

function createServer(gateway, options = {}) {
    const maxBodyBytes = options.maxBodyBytes || 1024 * 1024;
    return http.createServer(async (request, response) => {
        const requestId = APIGatewayMax.requestId(request.headers['x-request-id']);
        response.setHeader('x-request-id', requestId);
        try {
            const url = new URL(request.url, 'http://gateway.local');
            if (url.pathname === '/__gateway/health') return sendJson(response, 200, { status: 'healthy', ...gateway.status() });
            if (url.pathname === '/__gateway/routes') return sendJson(response, 200, { routes: gateway.status().routes });
            const body = await readBody(request, maxBodyBytes);
            const result = await gateway.proxy({ pathname: url.pathname, search: url.search, method: request.method, headers: request.headers, body: body.length ? body : undefined, clientId: request.socket.remoteAddress, requestId });
            response.statusCode = result.response.status;
            for (const [key, value] of result.response.headers) if (!['connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) response.setHeader(key, value);
            if (result.response.body) Readable.fromWeb(result.response.body).pipe(response);
            else response.end();
        } catch (error) { sendJson(response, error.statusCode || 500, { error: error.message, requestId }); }
    });
}

async function readBody(request, limit) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) { const error = new Error('Request body too large'); error.statusCode = 413; throw error; } chunks.push(chunk); } return Buffer.concat(chunks); }
function sendJson(response, status, value) { const body = Buffer.from(JSON.stringify(value)); response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length }); response.end(body); }

async function main(argv = process.argv.slice(2)) {
    const args = minimist(argv, { string: ['config', 'host', 'port'], boolean: ['help'], default: { host: '127.0.0.1' }, alias: { h: 'help', c: 'config' } });
    if (args.help || !args.config) { console.log('Usage: apigatewaymax --config gateway.json [--host 127.0.0.1] [--port 8080]'); return args.help ? 0 : 1; }
    const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    const port = Number(args.port ?? config.port ?? 8080);
    const server = createServer(new APIGatewayMax(config));
    await new Promise((resolve, reject) => server.once('error', reject).listen(port, args.host, resolve));
    console.log(`APIGatewayMax listening on http://${args.host}:${server.address().port}`);
    return new Promise(() => {});
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(`APIGatewayMax: ${error.message}`); process.exitCode = 1; });
module.exports = { createServer, main };
