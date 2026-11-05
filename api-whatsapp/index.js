const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const mysql = require('mysql2/promise');

// Configuração do pool do MySQL apontando para as variáveis que você configurou no Render
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

let sock;
let latestQr = null;

// Função para gravar e ler as chaves de sessão direto no MySQL do cPanel
async function useMySQLAuthState() {
    const readData = async (id) => {
        const [rows] = await pool.query('SELECT session_data FROM sessions_api_whatsapp WHERE session_id = ?', [id]);
        if (rows.length > 0) return JSON.parse(rows[0].session_data, BufferJSON.reviver);
        return null;
    };

    const writeData = async (data, id) => {
        const dataString = JSON.stringify(data, BufferJSON.replacer);
        await pool.query(
            'INSERT INTO sessions_api_whatsapp (session_id, session_data) VALUES (?, ?) ON DUPLICATE KEY UPDATE session_data = VALUES(session_data)',
            [id, dataString]
        );
    };

    const removeData = async (id) => {
        await pool.query('DELETE FROM sessions_api_whatsapp WHERE session_id = ?', [id]);
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function connectToWhatsApp() {
    // Utilizando a nova função de MySQL em vez da pasta local auth_info_baileys
    const { state, saveCreds } = await useMySQLAuthState();
    
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
            console.log('WhatsApp conectado com sucesso! ID:', sock?.user?.id);
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

// Baixa a imagem da notícia com suporte a redirecionamento e User-Agent
function downloadImageBuffer(imageUrl, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) {
            return reject(new Error('URL de imagem inválida ou vazia'));
        }
        if (redirects > 3) {
            return reject(new Error('Muitos redirecionamentos ao baixar imagem'));
        }

        const client = imageUrl.startsWith('https') ? https : http;
        const options = {
            rejectUnauthorized: false,
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8'
            }
        };

        const req = client.get(imageUrl, options, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                const nextUrl = new URL(res.headers.location, imageUrl).toString();
                return downloadImageBuffer(nextUrl, redirects + 1).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} ao baixar imagem`));
                return;
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                if (buffer.length === 0) {
                    reject(new Error('Imagem baixada está vazia (0 bytes)'));
                } else {
                    resolve(buffer);
                }
            });
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
        if (latestQr || !sock?.user) {
            const qrImageUrl = latestQr 
                ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(latestQr)}`
                : '';
            res.end(`
                <div style="text-align:center; font-family:sans-serif; margin-top:40px; background:#111; color:#fff; padding:20px; border-radius:10px; width:400px; margin-left:auto; margin-right:auto;">
                    <h2>Leia com o seu WhatsApp</h2>
                    ${qrImageUrl ? `<img src="${qrImageUrl}" alt="QR Code" style="border:10px solid white; border-radius:10px;" />` : `<p>Gerando QR Code, atualize a página em 3 segundos...</p>`}
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
                const message = data.message || data.text || data.caption || '';
                const number = data.number || data.group || data.chatId || data.to;
                const imageUrl = data.image || data.media || data.imagem || data.url || data.foto || null;
                
                if (!number || !message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Parâmetros "number" e "message" são obrigatórios.' }));
                    return;
                }

                if (!sock || !sock.user) {
                    console.log('Erro: Tentativa de envio com WhatsApp desconectado (leia o QR Code).');
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'WhatsApp desconectado. Escaneie o QR Code.' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, status: 'Envio enfileirado com sucesso!' }));

                setImmediate(async () => {
                    try {
                        const jid = String(number).includes('@') ? String(number) : `${String(number)}@s.whatsapp.net`;

                        let imageBuffer = null;
                        if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
                            try {
                                imageBuffer = await downloadImageBuffer(imageUrl);
                            } catch (dlErr) {
                                console.log('Aviso: Falha ao baixar imagem (' + imageUrl + '), enviando apenas texto:', dlErr.message);
                            }
                        }

                        if (imageBuffer) {
                            await sock.sendMessage(jid, {
                                image: imageBuffer,
                                caption: message
                            });
                            console.log('Mensagem COM IMAGEM enviada com sucesso para:', jid);
                        } else {
                            await sock.sendMessage(jid, { text: message });
                            console.log('Mensagem de TEXTO enviada com sucesso para:', jid);
                        }
                    } catch (bgErr) {
                        console.log('Erro crítico no envio pelo Baileys:', bgErr.message);
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