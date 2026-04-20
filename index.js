import { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import Anthropic from '@anthropic-ai/sdk';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';

// ========== CONFIGURACIÓN ==========
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'sk-ant-api03-oN8cZ9YvLxtP_rqrVmJt5MkBcXZOEGCNdpgF5CfWZpE8VLF2hE0Eg1R-8cCJjNW_pFGd9k7yP8Wd3Vx2QA9xAA';
const NOTIFICATION_NUMBER = '5212969644572@s.whatsapp.net';
const PORT = process.env.PORT || 3000;

// Inicializar Claude AI
const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

const MENU_CONOCIMIENTO = `
MENÚ BAGGO'S BAGUETTERÍA - José Cardel, Veracruz

🥖 BAGUETTES SENCILLAS 15CM - $40
Jamón, Salchicha, Pierna, Chorizo, Milanesa Res, Milanesa Pollo

🥖 BAGUETTES SENCILLAS 30CM - $60
Jamón, Salchicha, Pierna, Chorizo, Milanesa Res, Milanesa Pollo

🍱 COMBOS 15CM - $65 (Baguette + Papas + Refresco)
🍱 COMBOS 30CM - $95 (Baguette + Papas + Refresco)

🍔 BAGGO'S BURGER
Hamburguesa Sencilla - $80
Hamburguesa Doble - $120

➕ EXTRAS: Papas $20 | Refresco $15 | Queso $10 | Carne $15

HORARIO: Lun-Sáb 10AM-9PM | CERRADO: Martes
DOMICILIO: $15
`;

const SYSTEM_PROMPT = `Eres el asistente de Baggo's Baguettería.

MENÚ:
${MENU_CONOCIMIENTO}

FLUJO:
1. Saluda y ofrece menú
2. Ayuda a elegir
3. Captura: productos, cantidad, dirección, nombre, pago
4. Confirma todo
5. Responde SOLO JSON final:

{
  "pedido_completo": true,
  "cliente": "Nombre",
  "direccion": "Dirección",
  "productos": [{"nombre": "Combo 15cm Jamón", "cantidad": 2, "precio": 65}],
  "total": 145,
  "pago": "Efectivo",
  "notas": ""
}

Si es martes: avisa que estamos cerrados.
`;

async function procesarMensajeConClaude(mensaje, historial = []) {
    try {
        const mensajes = [...historial, { role: 'user', content: mensaje }];
        const respuesta = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: mensajes
        });
        return respuesta.content[0].text;
    } catch (error) {
        console.error('Error con Claude:', error);
        return 'Disculpa, tuve un problema. ¿Podrías repetir?';
    }
}

function generarComanda(pedidoJSON) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let comanda = '================================\n';
    comanda += '   BAGGO\'S BAGUETTERÍA\n';
    comanda += '================================\n\n';
    comanda += `CLIENTE: ${pedidoJSON.cliente}\n`;
    comanda += `DIRECCIÓN: ${pedidoJSON.direccion}\n`;
    comanda += `PAGO: ${pedidoJSON.pago}\n\n--- PEDIDO ---\n\n`;
    pedidoJSON.productos.forEach(p => {
        comanda += `${p.cantidad}x ${p.nombre} - $${p.precio * p.cantidad}\n`;
    });
    comanda += `\n================================\n`;
    comanda += `TOTAL: $${pedidoJSON.total}\n`;
    comanda += `================================\n`;
    console.log('\n📄 COMANDA GENERADA:\n', comanda);
    return comanda;
}

async function enviarNotificacion(sock, pedidoJSON) {
    const mensaje = `🔔 *NUEVO PEDIDO*\n\n` +
        `👤 ${pedidoJSON.cliente}\n` +
        `📍 ${pedidoJSON.direccion}\n` +
        `💰 Total: $${pedidoJSON.total}\n` +
        `💳 ${pedidoJSON.pago}\n\n` +
        `📋 Productos:\n` +
        pedidoJSON.productos.map(p => `• ${p.cantidad}x ${p.nombre}`).join('\n');
    await sock.sendMessage(NOTIFICATION_NUMBER, { text: mensaje });
}

async function conectarWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        version,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📱 ESCANEA ESTE QR CON WHATSAPP BUSINESS:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true;
            
            console.log('Conexión cerrada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => conectarWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ Bot conectado a WhatsApp');
        }
    });

    const conversaciones = {};

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const remitente = msg.key.remoteJid;
        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        console.log(`📩 ${remitente}: ${texto}`);
        
        if (!conversaciones[remitente]) conversaciones[remitente] = [];
        
        const respuesta = await procesarMensajeConClaude(texto, conversaciones[remitente]);
        
        conversaciones[remitente].push(
            { role: 'user', content: texto },
            { role: 'assistant', content: respuesta }
        );
        
        try {
            const jsonMatch = respuesta.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const pedidoJSON = JSON.parse(jsonMatch[0]);
                if (pedidoJSON.pedido_completo) {
                    generarComanda(pedidoJSON);
                    await enviarNotificacion(sock, pedidoJSON);
                    await sock.sendMessage(remitente, { 
                        text: '✅ ¡Pedido recibido! Llegará en 30-40 min. ¡Gracias!' 
                    });
                    conversaciones[remitente] = [];
                    return;
                }
            }
        } catch (e) {}
        
        await sock.sendMessage(remitente, { text: respuesta });
    });
}

// Servidor HTTP simple para Render
import http from 'http';
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot de WhatsApp activo\n');
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor HTTP en puerto ${PORT}`);
    console.log('🤖 Iniciando bot de WhatsApp...');
    conectarWhatsApp();
});
