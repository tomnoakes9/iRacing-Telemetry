/**
 * iRacing Telemetry Relay Server
 * Cloud server that relays telemetry between coaches and students anywhere in the world
 * Deploy to Heroku, AWS, or any Node.js hosting
 */

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Create Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Health check endpoint
app.get('/', (req, res) => {
  res.send('iRacing Telemetry Relay Server is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connections: clients.size,
    pairings: Array.from(pairings.values()).length
  });
});

// Store connected clients
const clients = new Map(); // sessionId -> { ws, isCoach, pairingCode, pairedWith }
const pairings = new Map(); // pairingCode -> coachSessionId

/**
 * Generate a simple 6-character pairing code
 */
function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 3; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  code += '-';
  for (let i = 0; i < 3; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Get unique pairing code
 */
function getUniquePairingCode() {
  let code;
  let attempts = 0;
  do {
    code = generatePairingCode();
    attempts++;
  } while (pairings.has(code) && attempts < 100);
  
  if (attempts >= 100) {
    throw new Error('Could not generate unique pairing code');
  }
  
  return code;
}

/**
 * Handle new WebSocket connection
 */
wss.on('connection', (ws) => {
  console.log('New connection');
  
  let sessionId = null;
  let clientData = null;
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'register':
          handleRegister(ws, data);
          break;
          
        case 'pair':
          handlePair(ws, data);
          break;
          
        case 'telemetry':
          handleTelemetry(ws, data);
          break;
          
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  });
  
  /**
   * Handle client registration
   */
  function handleRegister(ws, data) {
    sessionId = data.session_id;
    const isCoach = data.is_coach;
    
    console.log(`Client registered: ${sessionId} (${isCoach ? 'coach' : 'student'})`);
    
    // If client already exists, update connection
    if (clients.has(sessionId)) {
      const existing = clients.get(sessionId);
      existing.ws = ws;
      clientData = existing;
    } else {
      clientData = {
        ws,
        isCoach,
        pairingCode: null,
        pairedWith: null
      };
      clients.set(sessionId, clientData);
    }
    
    // If coach, generate and send pairing code
    if (isCoach) {
      const pairingCode = getUniquePairingCode();
      clientData.pairingCode = pairingCode;
      pairings.set(pairingCode, sessionId);
      
      ws.send(JSON.stringify({
        type: 'pairing_code',
        code: pairingCode
      }));
      
      console.log(`Assigned pairing code ${pairingCode} to coach ${sessionId}`);
    }
  }
  
  /**
   * Handle pairing request from student
   */
  function handlePair(ws, data) {
    const code = data.code.toUpperCase();
    
    if (!pairings.has(code)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid pairing code'
      }));
      return;
    }
    
    const coachSessionId = pairings.get(code);
    const coachData = clients.get(coachSessionId);
    
    if (!coachData || coachData.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Coach is not connected'
      }));
      return;
    }
    
    // Create pairing
    clientData.pairedWith = coachSessionId;
    coachData.pairedWith = sessionId;
    
    // Notify both parties
    ws.send(JSON.stringify({
      type: 'paired',
      peer_id: coachSessionId
    }));
    
    coachData.ws.send(JSON.stringify({
      type: 'paired',
      peer_id: sessionId
    }));
    
    console.log(`Paired student ${sessionId} with coach ${coachSessionId}`);
  }
  
  /**
   * Handle telemetry data
   */
  function handleTelemetry(ws, data) {
    if (!clientData || !clientData.pairedWith) {
      return; // Not paired, ignore telemetry
    }
    
    const peerData = clients.get(clientData.pairedWith);
    
    if (peerData && peerData.ws.readyState === WebSocket.OPEN) {
      // Forward telemetry to peer
      peerData.ws.send(JSON.stringify({
        type: 'telemetry',
        throttle: data.throttle,
        brake: data.brake,
        steering: data.steering,
        speed: data.speed,
        gear: data.gear,
        driver_name: data.driver_name
      }));
    }
  }
  
  ws.on('close', () => {
    console.log('Connection closed:', sessionId);
    
    if (clientData && clientData.pairedWith) {
      // Notify peer of disconnection
      const peerData = clients.get(clientData.pairedWith);
      if (peerData && peerData.ws.readyState === WebSocket.OPEN) {
        peerData.ws.send(JSON.stringify({
          type: 'peer_disconnected'
        }));
        peerData.pairedWith = null;
      }
    }
    
    // Clean up pairing code if coach
    if (clientData && clientData.isCoach && clientData.pairingCode) {
      pairings.delete(clientData.pairingCode);
    }
    
    // Note: Keep client in map for reconnection, but mark ws as closed
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});

// Cleanup disconnected clients periodically
setInterval(() => {
  for (const [sessionId, client] of clients.entries()) {
    if (client.ws.readyState === WebSocket.CLOSED) {
      // Remove if disconnected for more than 5 minutes
      if (!client.lastDisconnect) {
        client.lastDisconnect = Date.now();
      } else if (Date.now() - client.lastDisconnect > 5 * 60 * 1000) {
        clients.delete(sessionId);
        if (client.pairingCode) {
          pairings.delete(client.pairingCode);
        }
        console.log(`Cleaned up stale client: ${sessionId}`);
      }
    }
  }
}, 60000); // Check every minute
