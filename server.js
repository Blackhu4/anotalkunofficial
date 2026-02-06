const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let waitingUser = null;

// --- KONFIGURÁCIÓ ---
const SPAM_DELAY = 600; // Minimum ennyi idő (ms) kell két üzenet között (0.6 mp)
const SPAM_LIMIT = 5;   // Hányszor lehet megszegni a szabályt, mielőtt kidobjuk?

// --- KÁROMKODÁS LISTA ---
const badWords = [
    "bazdmeg", "basszameg", "kurva", "geci", "picsa", 
    "fasz", "szar", "fos", "buzi", "köcsög", "anyád", 
    "ribanc", "fogyatékos", "cigány", "zsidó", "nigger"
];

function filterProfanity(text) {
    let cleanText = text;
    badWords.forEach(word => {
        const regex = new RegExp(word, "gi"); 
        const stars = '*'.repeat(word.length);
        cleanText = cleanText.replace(regex, stars);
    });
    return cleanText;
}

io.on('connection', (socket) => {
    console.log('Felhasználó csatlakozott:', socket.id);
    
    // Kezdeti értékek beállítása
    socket.warnings = 0;      // Káromkodás miatti figyelmeztetések
    socket.spamCount = 0;     // Spam miatti figyelmeztetések
    socket.lastMsgTime = 0;   // Utolsó üzenet időpontja

    socket.on('find_partner', (nickname) => {
        let cleanNick = filterProfanity(nickname || 'Ismeretlen');
        socket.nickname = cleanNick;
        
        // Nullázunk mindent új keresésnél
        socket.warnings = 0;
        socket.spamCount = 0;
        socket.lastMsgTime = 0;

        if (waitingUser) {
            const partner = waitingUser;
            waitingUser = null;

            socket.partnerId = partner.id;
            partner.partnerId = socket.id;
            
            // Partnernek is nullázzuk a dolgait
            partner.warnings = 0;
            partner.spamCount = 0;

            socket.emit('chat_start', { partnerName: partner.nickname, initiator: true });
            partner.emit('chat_start', { partnerName: socket.nickname, initiator: false });

            console.log(`Pár: ${socket.nickname} <-> ${partner.nickname}`);
        } else {
            waitingUser = socket;
            socket.emit('waiting', 'Keresés...');
        }
    });

    socket.on('message', (msg) => {
        if (!socket.partnerId) return;

        // --- ANTI-SPAM ELLENŐRZÉS ---
        const now = Date.now();
        const timeDiff = now - socket.lastMsgTime;

        // Ha túl gyorsan küldte (kevesebb, mint SPAM_DELAY ms telt el)
        if (timeDiff < SPAM_DELAY) {
            socket.spamCount++;

            // Ha túl sokat spammel (eléri a limitet) -> KICK
            if (socket.spamCount >= SPAM_LIMIT) {
                socket.emit('message', { text: "Rendszerüzenet: Túl gyorsan írtál (SPAM)! A kapcsolatot bontottuk.", from: 'system' });
                
                // Partner értesítése
                const partnerSocket = io.sockets.sockets.get(socket.partnerId);
                if (partnerSocket) {
                     io.to(socket.partnerId).emit('message', { text: "Rendszerüzenet: A partnert kizártuk SPAM miatt.", from: 'system' });
                }
                
                handleDisconnect(socket, true); // Kidobjuk
                return;
            } else {
                // Csak figyelmeztetjük (de az üzenetet NEM küldjük el a partnernek!)
                socket.emit('message', { text: `Rendszerüzenet: Túl gyorsan írsz! Lassíts! (${socket.spamCount}/${SPAM_LIMIT})`, from: 'system' });
                return; // Megállunk, nem megy tovább az üzenet
            }
        }
        
        // Ha nem volt spam, frissítjük az időt és csökkentjük a spam számlálót (hogy a véletlen gyorsírás ne büntessen örökre)
        socket.lastMsgTime = now;
        if (socket.spamCount > 0) socket.spamCount--; 

        // --- KÁROMKODÁS SZŰRÉS ---
        const cleanMsg = filterProfanity(msg);

        if (msg !== cleanMsg) {
            socket.warnings++;
            if (socket.warnings >= 3) {
                socket.emit('message', { text: "Rendszerüzenet: Túl sokat káromkodtál! A kapcsolatot bontottuk.", from: 'system' });
                handleDisconnect(socket, true);
                
                const partnerSocket = io.sockets.sockets.get(socket.partnerId);
                if (partnerSocket) {
                     io.to(socket.partnerId).emit('message', { text: "Rendszerüzenet: A partnert kizártuk káromkodás miatt.", from: 'system' });
                }
                return;
            } else {
                socket.emit('message', { text: `Rendszerüzenet: Káromkodás észlelve! ${socket.warnings}/3 figyelmeztetés.`, from: 'system' });
            }
        }

        // Ha minden rendben, mehet az üzenet
        io.to(socket.partnerId).emit('message', { text: cleanMsg, from: 'partner' });
        socket.emit('message', { text: cleanMsg, from: 'me' });
    });

    socket.on('signal', (data) => {
        if (socket.partnerId) {
            io.to(socket.partnerId).emit('signal', data);
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });

    socket.on('next_partner', () => {
        handleDisconnect(socket);
    });

    function handleDisconnect(userSocket, isKicked = false) {
        if (waitingUser === userSocket) {
            waitingUser = null;
        }
        if (userSocket.partnerId) {
            const partnerSocket = io.sockets.sockets.get(userSocket.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('partner_disconnected');
                partnerSocket.partnerId = null;
            }
            if (isKicked) {
                userSocket.emit('partner_disconnected');
            }
            userSocket.partnerId = null;
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Szerver fut: http://localhost:${PORT}`);
});