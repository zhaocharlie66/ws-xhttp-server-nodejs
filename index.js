const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, createWebSocketStream } = require('ws');
const crypto = require('crypto');
const dns = require('dns').promises;

// ==========================================
// 1. 全局配置
// ==========================================

const DEFAULT_UUID = 'b389e09c-4e31-40da-a56c-433f507e615a';
const UUID = (process.env.UUID || DEFAULT_UUID).trim();
const PORT = parseInt(process.env.PORT || '1234', 10);
const WSPATH = process.env.WSPATH || UUID.substring(0, 8);

const xhttpSessions = new Map();

// 日志工具 (已静默)
function log(...args) {
    // const time = new Date().toISOString().substring(11, 19);
    // console.log(`[${time}]`, ...args);
}

// ==========================================
// 2. 辅助函数
// ==========================================

async function resolveHost(host) {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (ipRegex.test(host)) return host;
    try {
        const { address } = await dns.lookup(host, { family: 4 });
        return address;
    } catch (e) {
        return host;
    }
}

function setupXhttpResponse(res) {
    if (!res.headersSent) {
        res.writeHead(200, {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Content-Type': 'application/octet-stream',
            'Connection': 'keep-alive',
            'Pragma': 'no-cache',
            'Transfer-Encoding': 'chunked'
        });
        if (res.flushHeaders) res.flushHeaders();
    }
    if (res.socket) res.socket.setNoDelay(true);
}

// ==========================================
// 3. 服务核心
// ==========================================

const server = http.createServer((req, res) => {
    req.setTimeout(0); 

    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end('<h1>NodeJS Server</h1>'); // 伪装成普通服务
        return;
    }

    if (req.url === '/debug_network') {
        handleDebugNetwork(res);
        return;
    }

    if (req.url.startsWith(`/${WSPATH}`)) {
        const pathPart = req.url.split('?')[0]; 
        const parts = pathPart.split('/');
        let sessionId = parts[2]; 

        if (!sessionId || sessionId.trim() === '') {
            sessionId = `stream-none-${crypto.randomUUID()}`;
        }

        if (req.method === 'GET') {
            handleXhttpGet(req, res, sessionId);
        } else {
            handleXhttpPost(req, res, sessionId);
        }
        return;
    }

    res.writeHead(404);
    res.end();
});

server.on('checkContinue', (req, res) => {
    res.writeContinue();
    server.emit('request', req, res);
});

// ==========================================
// 4. XHTTP 逻辑核心 (Ack & Divert)
// ==========================================

function tryWrite(res, chunk) {
    if (!res || res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) {
        return false;
    }
    try {
        res.write(chunk);
        return true;
    } catch (e) {
        return false;
    }
}

function sendDownlinkData(sessionId, chunk, isHandshake = false) {
    const session = xhttpSessions.get(sessionId);
    if (!session) return;

    let sent = false;

    // 1. 优先尝试 GET (Stream-Up, Packet-Up, Auto)
    if (tryWrite(session.downloadRes, chunk)) {
        sent = true;
    }
    
    // 2. 如果没有 GET (Stream-None)，或者 GET 写失败，尝试 POST
    if (!sent) {
        if (tryWrite(session.postRes, chunk)) {
            sent = true;
        }
    }

    // 3. 失败缓冲
    if (!sent) {
        session.buffer.push({ chunk, isHandshake });
    }
}

function flushBuffer(session) {
    if (session.buffer.length > 0) {
        const temp = [...session.buffer];
        session.buffer = [];
        const sId = [...xhttpSessions.entries()].find(([k,v]) => v === session)?.[0];
        if (sId) {
            temp.forEach(item => {
                if (Buffer.isBuffer(item)) sendDownlinkData(sId, item, false);
                else sendDownlinkData(sId, item.chunk, item.isHandshake);
            });
        }
    }
}

function handleXhttpGet(req, res, sessionId) {
    setupXhttpResponse(res);
    let session = xhttpSessions.get(sessionId);
    if (!session) {
        session = createSession(sessionId);
        session.state = 'IDLE';
    }
    session.downloadRes = res;
    flushBuffer(session);
    
    const cleanup = () => { if(session.downloadRes === res) session.downloadRes = null; };
    res.on('close', cleanup);
    req.on('error', cleanup);
}

function handleXhttpPost(req, res, sessionId) {
    setupXhttpResponse(res);

    // 识别模式
    const hasContentLength = req.headers['content-length'] !== undefined;
    
    let session = xhttpSessions.get(sessionId);
    
    if (!session) {
        // Stream-None 或者是 Packet 模式的第一包(但 GET 还没到)
        session = createSession(sessionId);
        session.state = 'CONNECTING';
        session.postRes = res;
        processNewHandshake(req, sessionId, session);
    } else {
        // 已存在会话
        session.postRes = res;
        
        // 【核心策略】Ack & Divert
        // 如果我们有 GET 通道 (downloadRes)，并且这是一个 Packet 请求 (Content-Length)
        // 说明数据应该走 GET，而当前的 POST 只是用来上传的，必须立即由服务端 Ack 结束
        if (session.downloadRes && hasContentLength) {
            req.on('end', () => {
                if (!res.writableEnded) {
                    res.end();
                }
            });
        }
        
        flushBuffer(session);

        if (session.state === 'ESTABLISHED') {
            if (session.target) req.pipe(session.target, { end: false });
        
        } else if (session.state === 'CONNECTING') {
            session.pendingUplinks.push(req);
        
        } else if (session.state === 'IDLE') {
            session.state = 'CONNECTING';
            processNewHandshake(req, sessionId, session);
        }
    }

    res.on('close', () => { 
        if (session && session.postRes === res) session.postRes = null; 
    });
    req.on('error', () => {});
}

function processNewHandshake(req, sessionId, session) {
    req.once('data', async (firstChunk) => {
        req.pause();
        try {
            if (session.target) {
                session.target.write(firstChunk);
                req.pipe(session.target, { end: false });
                req.resume();
                return;
            }

            let success = false;
            
            if (firstChunk.length >= 17 && firstChunk[0] === 0x00) {
                log(`[XHTTP] Session: ${sessionId} (VLESS)`);
                success = await handleProxyProtocol(req, sessionId, firstChunk, 'vless');
            } else if (firstChunk.length >= 58) {
                success = await handleProxyProtocol(req, sessionId, firstChunk, 'trojan');
                if(success) log(`[XHTTP] Session: ${sessionId} (Trojan)`);
            } else {
                log(`[XHTTP] Unknown Hex`);
            }

            if (!success) cleanupSession(sessionId, 'Protocol Error');

        } catch (e) {
            log(`[XHTTP] Error: ${e.message}`);
            cleanupSession(sessionId, 'Error');
        }
    });
}


function createSession(id) {
    const s = { 
        downloadRes: null, postRes: null, target: null, 
        buffer: [], state: 'IDLE', pendingUplinks: []
    };
    xhttpSessions.set(id, s);
    setTimeout(() => {
        const c = xhttpSessions.get(id);
        if (c && !c.target && c.state !== 'ESTABLISHED') cleanupSession(id, 'Timeout');
    }, 60000);
    return s;
}

function cleanupSession(id, reason) {
    if (xhttpSessions.has(id)) {
        const s = xhttpSessions.get(id);
        setTimeout(() => {
            if (reason === 'Target Closed' || reason === 'Target Error' || reason === 'Protocol Error' || reason === 'Error') {
                if (s.target && !s.target.destroyed) s.target.destroy();
                if (s.downloadRes && !s.downloadRes.writableEnded) s.downloadRes.end();
                if (s.postRes && !s.postRes.writableEnded) s.postRes.end();
                s.pendingUplinks.forEach(r => r.destroy());
                xhttpSessions.delete(id);
            }
        }, 500);
    }
}

async function handleDebugNetwork(res) {
    res.writeHead(200, {'Content-Type':'application/json'}); 
    res.end(JSON.stringify({status: 'ok'}));
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});
wss.on('connection', (ws, req) => {
    const wsStream = createWebSocketStream(ws);
    wsStream.once('data', async (firstChunk) => {
        wsStream.pause();
        let success = false;
        if (firstChunk.length >= 17 && firstChunk[0] === 0x00) success = await handleProxyProtocol(wsStream, null, firstChunk, 'vless');
        else if (firstChunk.length >= 58) success = await handleProxyProtocol(wsStream, null, firstChunk, 'trojan');
        if (!success) ws.close();
    });
});

async function handleProxyProtocol(inputStream, sessionId, firstChunk, type) {
    let cursor = 0; let host = ''; let port = 0; let initialPayloadCursor = 0;
    const localUUIDBuffer = Buffer.from(UUID.replace(/-/g, ''), 'hex');

    if (type === 'vless') {
        const reqUUID = firstChunk.subarray(1, 17);
        if (!reqUUID.equals(localUUIDBuffer)) return false;
        cursor = 17; const optLen = firstChunk[cursor]; cursor += 1 + optLen + 1;
        port = firstChunk.readUInt16BE(cursor); cursor += 2;
        const atyp = firstChunk[cursor]; cursor += 1;
        if (atyp === 1) { host = firstChunk.subarray(cursor, cursor + 4).join('.'); cursor += 4; }
        else if (atyp === 2) { const domainLen = firstChunk[cursor]; cursor += 1; host = firstChunk.subarray(cursor, cursor + domainLen).toString('utf8'); cursor += domainLen; }
        else if (atyp === 3) { cursor += 16; host = "ipv6"; } else return false;
        initialPayloadCursor = cursor;
    } else if (type === 'trojan') {
        const reqHash = firstChunk.subarray(0, 56).toString('utf8');
        const localHash = crypto.createHash('sha224').update(UUID).digest('hex');
        if (reqHash.toLowerCase() !== localHash.toLowerCase()) return false;
        cursor = 56;
        if (firstChunk[cursor] === 0x0d && firstChunk[cursor + 1] === 0x0a) cursor += 2;
        if (firstChunk[cursor] !== 0x01) return false; cursor += 2; 
        if (firstChunk[cursor-1] === 1) { host = firstChunk.subarray(cursor, cursor + 4).join('.'); cursor += 4; }
        else if (firstChunk[cursor-1] === 3) { const domainLen = firstChunk[cursor]; cursor += 1; host = firstChunk.subarray(cursor, cursor + domainLen).toString('utf8'); cursor += domainLen; }
        else if (firstChunk[cursor-1] === 4) { cursor += 16; host = "ipv6"; } else return false;
        port = firstChunk.readUInt16BE(cursor); cursor += 2;
        if (firstChunk.length >= cursor + 2 && firstChunk[cursor] === 0x0d && firstChunk[cursor + 1] === 0x0a) cursor += 2;
        initialPayloadCursor = cursor;
    }

    const targetIP = await resolveHost(host);
    const tcpSocket = net.connect(port, targetIP);
    tcpSocket.setNoDelay(true);

    if (sessionId) {
        const s = xhttpSessions.get(sessionId);
        if (s) s.target = tcpSocket;
    }

    tcpSocket.on('connect', () => {
        if (type === 'vless') {
            const header = Buffer.from([0x00, 0x00]);
            if (sessionId) sendDownlinkData(sessionId, header, true); 
            else inputStream.write(header);
        }

        if (sessionId) {
            const s = xhttpSessions.get(sessionId);
            if (s) {
                s.state = 'ESTABLISHED';
                while (s.pendingUplinks.length > 0) {
                    s.pendingUplinks.shift().pipe(tcpSocket, { end: false });
                }
            }
        }

        if (initialPayloadCursor < firstChunk.length) tcpSocket.write(firstChunk.subarray(initialPayloadCursor));

        inputStream.resume();
        const pipeOpts = sessionId ? { end: false } : { end: true };
        inputStream.pipe(tcpSocket, pipeOpts);

        if (sessionId) {
            tcpSocket.on('data', (c) => sendDownlinkData(sessionId, c, false));
        } else {
            tcpSocket.pipe(inputStream);
        }
    });

    tcpSocket.on('error', (e) => {
        if (sessionId) cleanupSession(sessionId, 'Target Error');
        else try{inputStream.destroy()}catch(e){}
    });
    tcpSocket.on('close', () => {
        if (sessionId) cleanupSession(sessionId, 'Target Closed');
        else try{inputStream.destroy()}catch(e){}
    });

    return true;
}

server.listen(PORT, '0.0.0.0', () => {
    // console.log(`========================================`);
    // console.log(`NodeJS Proxy Server Started`);
    // console.log(`Port: ${PORT}`);
    // console.log(`========================================`);
});