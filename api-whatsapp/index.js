const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

let sock;
let latestQr = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            latestQr = qr;
        }
        
        if (connection === 'close') {
            latestQr = null;
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            latestQr = null;
            try {
                const groups = await sock.groupFetchAllParticipating();
                let txt = "LISTA DOS MEUS GRUPOS DO WHATSAPP:\n\n";
                for (const [jid, group] of Object.entries(groups)) {
                    txt += `Grupo: "${group.subject}"\nID: ${jid}\n-----------------------------------\n`;
                }
                fs.writeFileSync('./grupos.txt', txt);
            } catch (err) {}
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

function downloadImageBuffer(imageUrl) {
    return new Promise((resolve, reject) => {
        const client = imageUrl.startsWith('https') ? https : http;
        const options = {
            rejectUnauthorized: false,
            timeout: 10000
        };

        const req = client.get(imageUrl, options, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} ao baixar imagem`));
                return;
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', (err) => reject(err));
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout ao baixar imagem'));
        });
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (latestQr) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}`;
            res.end(`
                <div style="text-align:center; font-family:sans-serif; margin-top:40px; background:#111; color:#fff; padding:20px; border-radius:10px; width:400px; margin-left:auto; margin-right:auto;">
                    <h2>Leia com o seu WhatsApp</h2>
                    <img src="${qrImageUrl}" alt="QR Code" style="border:10px solid white; border-radius:10px;" />
                    <br><br>
                    <a href="/grupos.txt" style="color:#4CAF50; font-size:16px;">Ver Grupos</a>
                </div>
            `);
        } else {
            res.end(`
                <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                    <h2 style="color:green;">WhatsApp Conectado!</h2>
                    <p><a href="/grupos.txt" style="font-size:18px;">Ver IDs dos Grupos (/grupos.txt)</a></p>
                </div>
            `);
        }
        return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/grupos.txt') {
        if (fs.existsSync('./grupos.txt')) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(fs.readFileSync('./grupos.txt', 'utf8'));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Ainda sem grupos carregados.');
        }
        return;
    }
    
    if (req.method === 'POST' && parsedUrl.pathname === '/send') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const message = data.message || data.text || '';
                const number = data.number || data.group || data.chatId || data.to;
                
                if (!number || !message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Parâmetros "number" e "message" são obrigatórios.' }));
                    return;
                }

                if (!sock) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'WhatsApp ainda não inicializado.' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, status: 'Envio enfileirado com sucesso!' }));

                setImmediate(async () => {
                    try {
                        const jid = String(number).includes('@') ? String(number) : `${String(number)}@s.whatsapp.net`;

                        // Envia direto como texto para garantir que a mensagem chegue ao grupo sem falhas de buffer/imagem
                        await sock.sendMessage(jid, { text: message });

                    } catch (bgErr) {
                        console.log('Erro crítico no envio:', bgErr.message);
                    }
                });

            } catch (err) {
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'API WhatsApp Leve Ativa!' }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {});