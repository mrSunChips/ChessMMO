const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game state storage
let gameRooms = new Map();
let playerSessions = new Map(); // For reconnection handling

const ADMIN_PASSWORD = 'chipschessmmo';
const BOARD_SIZE = 200;
const MAX_PLAYERS = 20;

// Game state structure
function createGameRoom(roomId) {
    return {
        id: roomId,
        phase: 'lobby', // lobby, playing, ended
        players: new Map(),
        board: createBoard(),
        woods: generateWoods(),
        dangerZones: new Set(),
        shrinkTimer: 60,
        shrinkInterval: null,
        turn: 0,
        cooldowns: new Map(),
        admin: null,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
}

function createBoard() {
    const board = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
        board[row] = [];
        for (let col = 0; col < BOARD_SIZE; col++) {
            board[row][col] = { piece: null, woods: false };
        }
    }
    return board;
}

function generateWoods() {
    const woods = new Set();
    const numPatches = Math.floor(BOARD_SIZE * BOARD_SIZE * 0.05);
    
    for (let i = 0; i < numPatches; i++) {
        const centerRow = Math.floor(Math.random() * BOARD_SIZE);
        const centerCol = Math.floor(Math.random() * BOARD_SIZE);
        const patchSize = Math.floor(Math.random() * 8) + 3;
        
        for (let j = 0; j < patchSize; j++) {
            const offsetRow = Math.floor(Math.random() * 6) - 3;
            const offsetCol = Math.floor(Math.random() * 6) - 3;
            const row = centerRow + offsetRow;
            const col = centerCol + offsetCol;
            
            if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE) {
                woods.add(`${row},${col}`);
            }
        }
    }
    return woods;
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Store socket reference for reconnection
    socket.on('register_session', (data) => {
        const { sessionId, roomId } = data;
        playerSessions.set(sessionId, { socketId: socket.id, roomId, lastSeen: Date.now() });
        socket.sessionId = sessionId;
        socket.roomId = roomId;
    });
    
    // Join or create room
    socket.on('join_room', (data) => {
        const { roomId, playerName, isAdmin, adminPassword, sessionId } = data;
        
        // Validate admin password
        if (isAdmin && adminPassword !== ADMIN_PASSWORD) {
            socket.emit('join_error', { message: 'Invalid admin password' });
            return;
        }
        
        // Create room if it doesn't exist
        if (!gameRooms.has(roomId)) {
            gameRooms.set(roomId, createGameRoom(roomId));
        }
        
        const room = gameRooms.get(roomId);
        
        // Check if reconnecting
        const existingPlayer = Array.from(room.players.values()).find(p => p.sessionId === sessionId);
        
        if (existingPlayer) {
            // Reconnecting player
            existingPlayer.socketId = socket.id;
            existingPlayer.connected = true;
            socket.join(roomId);
            socket.roomId = roomId;
            socket.sessionId = sessionId;
            
            socket.emit('reconnected', {
                playerId: existingPlayer.id,
                gameState: serializeGameState(room),
                playerData: existingPlayer
            });
            
            socket.to(roomId).emit('player_reconnected', {
                playerId: existingPlayer.id,
                playerName: existingPlayer.name
            });
            
        } else {
            // New player
            if (room.players.size >= MAX_PLAYERS) {
                socket.emit('join_error', { message: 'Room is full' });
                return;
            }
            
            if (room.phase !== 'lobby') {
                socket.emit('join_error', { message: 'Game already in progress' });
                return;
            }
            
            const playerId = `player_${Date.now()}_${Math.random()}`;
            const player = {
                id: playerId,
                sessionId: sessionId,
                socketId: socket.id,
                name: playerName,
                isAdmin: isAdmin && !room.admin,
                color: getPlayerColor(room.players.size),
                pieces: [],
                alive: true,
                connected: true,
                joinedAt: Date.now()
            };
            
            if (player.isAdmin) {
                room.admin = playerId;
            }
            
            room.players.set(playerId, player);
            socket.join(roomId);
            socket.roomId = roomId;
            socket.playerId = playerId;
            socket.sessionId = sessionId;
            
            socket.emit('joined_room', {
                playerId: playerId,
                gameState: serializeGameState(room),
                playerData: player
            });
            
            socket.to(roomId).emit('player_joined', {
                player: player,
                totalPlayers: room.players.size
            });
        }
        
        room.lastActivity = Date.now();
    });
    
    // Start game (admin only)
    socket.on('start_game', () => {
        if (!socket.roomId) return;
        
        const room = gameRooms.get(socket.roomId);
        if (!room) return;
        
        const player = room.players.get(socket.playerId);
        if (!player || !player.isAdmin) {
            socket.emit('error', { message: 'Admin access required' });
            return;
        }
        
        if (room.phase !== 'lobby') {
            socket.emit('error', { message: 'Game already started' });
            return;
        }
        
        if (room.players.size < 2) {
            socket.emit('error', { message: 'Need at least 2 players' });
            return;
        }
        
        // Initialize game
        room.phase = 'playing';
        spawnPlayers(room);
        startShrinkTimer(room);
        
        io.to(socket.roomId).emit('game_started', {
            gameState: serializeGameState(room)
        });
    });
    
    // Move piece
    socket.on('move_piece', (data) => {
        if (!socket.roomId) return;
        
        const room = gameRooms.get(socket.roomId);
        if (!room || room.phase !== 'playing') return;
        
        const player = room.players.get(socket.playerId);
        if (!player || !player.alive) return;
        
        const { pieceId, fromRow, fromCol, toRow, toCol } = data;
        
        // Validate move
        const piece = findPiece(room, pieceId);
        if (!piece || piece.playerId !== socket.playerId) return;
        
        if (!isValidMove(room, piece, toRow, toCol)) {
            socket.emit('invalid_move', { message: 'Invalid move' });
            return;
        }
        
        // Execute move
        const success = executeMove(room, piece, toRow, toCol);
        if (success) {
            io.to(socket.roomId).emit('piece_moved', {
                pieceId: pieceId,
                fromRow: fromRow,
                fromCol: fromCol,
                toRow: toRow,
                toCol: toCol,
                playerId: socket.playerId,
                gameState: serializeGameState(room)
            });
            
            checkGameEnd(room);
        }
    });
    
    // Reset game (admin only)
    socket.on('reset_game', () => {
        if (!socket.roomId) return;
        
        const room = gameRooms.get(socket.roomId);
        if (!room) return;
        
        const player = room.players.get(socket.playerId);
        if (!player || !player.isAdmin) return;
        
        resetGame(room);
        io.to(socket.roomId).emit('game_reset', {
            gameState: serializeGameState(room)
        });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.roomId && socket.playerId) {
            const room = gameRooms.get(socket.roomId);
            if (room) {
                const player = room.players.get(socket.playerId);
                if (player) {
                    player.connected = false;
                    player.disconnectedAt = Date.now();
                    
                    socket.to(socket.roomId).emit('player_disconnected', {
                        playerId: socket.playerId,
                        playerName: player.name
                    });
                    
                    // Remove player after 5 minutes if not reconnected
                    setTimeout(() => {
                        if (room.players.has(socket.playerId)) {
                            const p = room.players.get(socket.playerId);
                            if (!p.connected) {
                                removePlayer(room, socket.playerId);
                                io.to(socket.roomId).emit('player_removed', {
                                    playerId: socket.playerId,
                                    gameState: serializeGameState(room)
                                });
                            }
                        }
                    }, 5 * 60 * 1000); // 5 minutes
                }
            }
        }
    });
});

// Helper functions
function getPlayerColor(index) {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FECA57', 
        '#FF9FF3', '#54A0FF', '#5F27CD', '#00D2D3', '#FF9F43',
        '#FD79A8', '#6C5CE7', '#A29BFE', '#FD79A8', '#FDCB6E',
        '#E17055', '#74B9FF', '#0984E3', '#00B894', '#FDCB6E'
    ];
    return colors[index % colors.length];
}

function spawnPlayers(room) {
    const spawnPositions = generateSpawnPositions(room.players.size);
    let index = 0;
    
    for (const [playerId, player] of room.players) {
        if (index >= spawnPositions.length) break;
        
        const spawn = spawnPositions[index];
        player.pieces = createPlayerPieces(playerId, spawn.row, spawn.col);
        
        // Place pieces on board
        player.pieces.forEach(piece => {
            room.board[piece.row][piece.col].piece = piece;
        });
        
        index++;
    }
}

function generateSpawnPositions(playerCount) {
    const positions = [];
    const minDistance = 20;
    const maxAttempts = 1000;
    
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex++) {
        let attempts = 0;
        let validPosition = false;
        
        while (!validPosition && attempts < maxAttempts) {
            const row = Math.floor(Math.random() * (BOARD_SIZE - 10)) + 5;
            const col = Math.floor(Math.random() * (BOARD_SIZE - 10)) + 5;
            
            let tooClose = false;
            for (const pos of positions) {
                const distance = Math.sqrt(Math.pow(row - pos.row, 2) + Math.pow(col - pos.col, 2));
                if (distance < minDistance) {
                    tooClose = true;
                    break;
                }
            }
            
            if (!tooClose) {
                positions.push({ row, col });
                validPosition = true;
            }
            attempts++;
        }
        
        if (!validPosition) {
            const edge = Math.floor(Math.random() * 4);
            let row, col;
            switch (edge) {
                case 0: row = 5; col = Math.floor(Math.random() * BOARD_SIZE); break;
                case 1: row = BOARD_SIZE - 5; col = Math.floor(Math.random() * BOARD_SIZE); break;
                case 2: row = Math.floor(Math.random() * BOARD_SIZE); col = 5; break;
                case 3: row = Math.floor(Math.random() * BOARD_SIZE); col = BOARD_SIZE - 5; break;
            }
            positions.push({ row, col });
        }
    }
    
    return positions;
}

function createPlayerPieces(playerId, startRow, startCol) {
    const pieces = [];
    const color = Math.random() > 0.5 ? 'white' : 'black';
    
    const pieceTypes = [
        { type: 'king', row: 0, col: 0 },
        { type: 'queen', row: 0, col: 1 },
        { type: 'rook', row: 0, col: -1 }, { type: 'rook', row: 0, col: 2 },
        { type: 'bishop', row: 0, col: -2 }, { type: 'bishop', row: 0, col: 3 },
        { type: 'knight', row: 0, col: -3 }, { type: 'knight', row: 0, col: 4 },
        { type: 'pawn', row: 1, col: -3 }, { type: 'pawn', row: 1, col: -2 },
        { type: 'pawn', row: 1, col: -1 }, { type: 'pawn', row: 1, col: 0 },
        { type: 'pawn', row: 1, col: 1 }, { type: 'pawn', row: 1, col: 2 },
        { type: 'pawn', row: 1, col: 3 }, { type: 'pawn', row: 1, col: 4 }
    ];
    
    pieceTypes.forEach((pieceData, index) => {
        const piece = {
            id: `${playerId}_${index}`,
            type: pieceData.type,
            color: color,
            playerId: playerId,
            row: Math.max(0, Math.min(BOARD_SIZE - 1, startRow + pieceData.row)),
            col: Math.max(0, Math.min(BOARD_SIZE - 1, startCol + pieceData.col)),
            canMove: true,
            cooldownExpires: 0
        };
        pieces.push(piece);
    });
    
    return pieces;
}

function startShrinkTimer(room) {
    room.shrinkInterval = setInterval(() => {
        if (room.phase !== 'playing') {
            clearInterval(room.shrinkInterval);
            return;
        }
        
        room.shrinkTimer--;
        
        if (room.shrinkTimer <= 0) {
            shrinkBoard(room);
            room.shrinkTimer = 1;
        }
        
        io.to(room.id).emit('timer_update', {
            shrinkTimer: room.shrinkTimer,
            dangerZones: Array.from(room.dangerZones)
        });
    }, 1000);
}

function shrinkBoard(room) {
    const borderSquares = [];
    
    for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
            if ((row === 0 || row === BOARD_SIZE - 1 || col === 0 || col === BOARD_SIZE - 1) &&
                !room.dangerZones.has(`${row},${col}`)) {
                borderSquares.push({ row, col });
            }
        }
    }
    
    for (let i = 0; i < Math.min(2, borderSquares.length); i++) {
        const randomIndex = Math.floor(Math.random() * borderSquares.length);
        const square = borderSquares.splice(randomIndex, 1)[0];
        room.dangerZones.add(`${square.row},${square.col}`);
        
        const piece = room.board[square.row][square.col].piece;
        if (piece) {
            removePieceFromGame(room, piece);
        }
    }
}

function isValidMove(room, piece, toRow, toCol) {
    // Basic bounds check
    if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) {
        return false;
    }
    
    // Check if destination is woods or danger zone
    if (room.woods.has(`${toRow},${toCol}`) || room.dangerZones.has(`${toRow},${toCol}`)) {
        return false;
    }
    
    // Check cooldown
    if (!piece.canMove && piece.type !== 'king') {
        return false;
    }
    
    // Find king position for distance check
    const player = room.players.get(piece.playerId);
    const king = player.pieces.find(p => p.type === 'king');
    if (king) {
        const distanceToKing = Math.max(Math.abs(toRow - king.row), Math.abs(toCol - king.col));
        if (distanceToKing > 10) {
            return false;
        }
    }
    
    // TODO: Add proper chess movement validation
    return true;
}

function executeMove(room, piece, toRow, toCol) {
    // Remove piece from old position
    room.board[piece.row][piece.col].piece = null;
    
    // Handle capture
    const capturedPiece = room.board[toRow][toCol].piece;
    if (capturedPiece) {
        removePieceFromGame(room, capturedPiece);
    }
    
    // Move piece
    piece.row = toRow;
    piece.col = toCol;
    room.board[toRow][toCol].piece = piece;
    
    // Set cooldown
    if (piece.type !== 'king') {
        piece.canMove = false;
        piece.cooldownExpires = Date.now() + 5000;
        
        setTimeout(() => {
            piece.canMove = true;
            io.to(room.id).emit('cooldown_expired', {
                pieceId: piece.id
            });
        }, 5000);
    }
    
    return true;
}

function removePieceFromGame(room, piece) {
    const player = room.players.get(piece.playerId);
    if (player) {
        player.pieces = player.pieces.filter(p => p.id !== piece.id);
        
        if (player.pieces.length === 0) {
            player.alive = false;
        }
    }
}

function findPiece(room, pieceId) {
    for (const [playerId, player] of room.players) {
        const piece = player.pieces.find(p => p.id === pieceId);
        if (piece) return piece;
    }
    return null;
}

function checkGameEnd(room) {
    const alivePlayers = Array.from(room.players.values()).filter(p => p.alive && p.pieces.length > 0);
    
    if (alivePlayers.length <= 1) {
        room.phase = 'ended';
        if (room.shrinkInterval) {
            clearInterval(room.shrinkInterval);
        }
        
        const winner = alivePlayers[0];
        io.to(room.id).emit('game_ended', {
            winner: winner ? winner.name : null,
            gameState: serializeGameState(room)
        });
    }
}

function resetGame(room) {
    room.phase = 'lobby';
    room.board = createBoard();
    room.woods = generateWoods();
    room.dangerZones.clear();
    room.shrinkTimer = 60;
    room.turn = 0;
    room.cooldowns.clear();
    
    if (room.shrinkInterval) {
        clearInterval(room.shrinkInterval);
    }
    
    // Reset all players
    for (const [playerId, player] of room.players) {
        player.pieces = [];
        player.alive = true;
    }
}

function removePlayer(room, playerId) {
    const player = room.players.get(playerId);
    if (player) {
        // Remove player's pieces from board
        player.pieces.forEach(piece => {
            room.board[piece.row][piece.col].piece = null;
        });
        
        room.players.delete(playerId);
        
        // If admin left, assign new admin
        if (room.admin === playerId && room.players.size > 0) {
            const newAdmin = Array.from(room.players.values())[0];
            newAdmin.isAdmin = true;
            room.admin = newAdmin.id;
        }
    }
}

function serializeGameState(room) {
    return {
        phase: room.phase,
        players: Array.from(room.players.values()).map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            isAdmin: p.isAdmin,
            alive: p.alive,
            connected: p.connected,
            pieceCount: p.pieces.length
        })),
        boardSize: BOARD_SIZE,
        woods: Array.from(room.woods),
        dangerZones: Array.from(room.dangerZones),
        shrinkTimer: room.shrinkTimer,
        turn: room.turn
    };
}

// Cleanup old rooms
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of gameRooms) {
        if (now - room.lastActivity > 24 * 60 * 60 * 1000) { // 24 hours
            gameRooms.delete(roomId);
        }
    }
}, 60 * 60 * 1000); // Check every hour

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        rooms: gameRooms.size,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Chess Battle Royale server running on port ${PORT}`);
});

module.exports = { app, server };