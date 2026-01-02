/**
 * iRacing Telemetry Relay Server - V2
 * Simple code-based pairing system
 */

const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
  res.send('iRacing Telemetry Relay Server V2 is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0',
    connections: clients.size,
    active_codes: codes.size
  });
});

// Store clients and codes
const clients = new Map(); // sessionId -> { ws, isSharer, code, pairedWith }
const codes = new Map(); // code -> sharerSessionId

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
  
  function handleRegister(ws, data) {
    sessionId = data.session_id;
    const isSharer = data.is_sharer;
    const code = data.code.toUpperCase().trim();
    
    console.log(`Client registered: ${sessionId} (${isSharer ? 'sharer' : 'viewer'}) with code: ${code}`);
    
    clientData = {
      ws,
      isSharer,
      code,
      pairedWith: null
    };
    clients.set(sessionId, clientData);
    
    if (isSharer) {
      // Sharer: register the code
      codes.set(code, sessionId);
      console.log(`Registered code ${code} for sharer ${sessionId}`);
      
    } else {
      // Viewer: try to pair with sharer
      if (!codes.has(code)) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Code not found. Make sure the sharer is connected.'
        }));
        return;
      }
      
      const sharerSessionId = codes.get(code);
      const sharerData = clients.get(sharerSessionId);
      
      if (!sharerData || sharerData.ws.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Sharer is not online'
        }));
        return;
      }
      
      // Create pairing
      clientData.pairedWith = sharerSessionId;
      sharerData.pairedWith = sessionId;
      
      // Notify both
      ws.send(JSON.stringify({
        type: 'paired',
        peer_id: sharerSessionId,
        peer_name: 'Sharer'
      }));
      
      sharerData.ws.send(JSON.stringify({
        type: 'paired',
        peer_id: sessionId,
        peer_name: 'Viewer'
      }));
      
      console.log(`Paired viewer ${sessionId} with sharer ${sharerSessionId}`);
    }
  }
  
  function handleTelemetry(ws, data) {
    if (!clientData || !clientData.pairedWith) {
      return;
    }
    
    const peerData = clients.get(clientData.pairedWith);
    
    if (peerData && peerData.ws.readyState === WebSocket.OPEN) {
      peerData.ws.send(JSON.stringify({
        type: 'telemetry',
        throttle: data.throttle,
        brake: data.brake,
        steering: data.steering,
        speed: data.speed,
        gear: data.gear,
        driver_name: data.driver_name,
        session_time: data.session_time
      }));
    }
  }
  
  ws.on('close', () => {
    console.log('Connection closed:', sessionId);
    
    if (clientData && clientData.pairedWith) {
      const peerData = clients.get(clientData.pairedWith);
      if (peerData && peerData.ws.readyState === WebSocket.OPEN) {
        peerData.ws.send(JSON.stringify({
          type: 'unpaired'
        }));
        peerData.pairedWith = null;
      }
    }
    
    if (clientData && clientData.isSharer && clientData.code) {
      codes.delete(clientData.code);
    }
    
    if (sessionId) {
      clients.delete(sessionId);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.listen(PORT, () => {
  console.log(`Relay server V2 listening on port ${PORT}`);
});

// Cleanup
setInterval(() => {
  for (const [sessionId, client] of clients.entries()) {
    if (client.ws.readyState === WebSocket.CLOSED) {
      clients.delete(sessionId);
      if (client.isSharer && client.code) {
        codes.delete(client.code);
      }
      console.log(`Cleaned up stale client: ${sessionId}`);
    }
  }
}, 60000);
