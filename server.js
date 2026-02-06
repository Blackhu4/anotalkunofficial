const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

let waitingUser = null;

// --- KONFIGURÁCIÓ ---
const SPAM_DELAY = 600; 
const SPAM_LIMIT = 5;
const MAX_MSG_LENGTH = 500; 

const badWords = [
    "bazdmeg", "basszameg", "kurva", "geci", "picsa", 
    "fasz", "szar", "fos", "buzi", "köcsög", "anyád", 
    "ribanc", "fogyatékos", "cigány", "zsidó", "nigger",
    "kurv", "gec", "faszfej"
];

function filterProfanity(text) {
    if (!text) return "";
    let cleanText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, "gi"); 
        const stars = '*'.repeat(word.length);
        cleanText = cleanText.replace(regex, stars);
    });
    return cleanText;
}

io.on('connection', (socket) => {
    socket.warnings = 0;      
    socket.spamCount = 0;     
    socket.lastMsgTime = 0;   

    socket.on('find_partner', (nickname) => {
        let rawNick = nickname || 'Ismeretlen';
        let filteredNick = filterProfanity(rawNick);

        // Név ellenőrzése: Ha csúnya volt, vagy túl hosszú
        if (filteredNick !== rawNick) {
            socket.nickname = 'Ismeretlen'; 
        } else {
            socket.nickname = filteredNick.substring(0, 15);
        }
        
        socket.warnings = 0;
        socket.spamCount = 0;

        if (waitingUser) {
            const partner = waitingUser;
            waitingUser = null;
            socket.partnerId = partner.id;
            partner.partnerId = socket.id;
            socket.emit('chat_start', { partnerName: partner.nickname, initiator: true });
            partner.emit('chat_start', { partnerName: socket.nickname, initiator: false });
        } else {
            waitingUser = socket;
            socket.emit('waiting', 'Keresés...');
        }
    });

    socket.on('message', (msg) => {
        if (!socket.partnerId) return;
        const now = Date.now();
        if (now - socket.lastMsgTime < SPAM_DELAY) {
            socket.spamCount++;
            if (socket.spamCount >= SPAM_LIMIT) {
                socket.emit('message', { text: "Rendszer: SPAM miatt kidobtunk.", from: 'system' });
                handleDisconnect(socket, true); 
                return;
            }
            return;
        }
        socket.lastMsgTime = now;

        // Üzenet vágása és szűrése
        let finalMsg = msg.substring(0, MAX_MSG_LENGTH);
        const cleanMsg = filterProfanity(finalMsg);

        if (finalMsg !== cleanMsg) {
            socket.warnings++;
            if (socket.warnings >= 3) {
                socket.emit('message', { text: "Rendszer: Káromkodás miatt kidobtunk.", from: 'system' });
                handleDisconnect(socket, true);
                return;
            }
        }

        io.to(socket.partnerId).emit('message', { text: cleanMsg, from: 'partner' });
        socket.emit('message', { text: cleanMsg, from: 'me' });
    });

    socket.on('signal', (data) => {
        if (socket.partnerId) io.to(socket.partnerId).emit('signal', data);
    });

    socket.on('disconnect', () => handleDisconnect(socket));
    socket.on('next_partner', () => handleDisconnect(socket));

    function handleDisconnect(userSocket, isKicked = false) {
        if (waitingUser === userSocket) waitingUser = null;
        if (userSocket.partnerId) {
            const partnerSocket = io.sockets.sockets.get(userSocket.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('partner_disconnected');
                partnerSocket.partnerId = null;
            }
            userSocket.partnerId = null;
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Szerver: http://localhost:${PORT}`));