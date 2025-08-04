import express from 'express';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

let activeTranscripts = {}; // { callSid: { transcript: '', suggestions: [] } }

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, request, client) => {
  console.log('📡 WebSocket Connected');

  let callSid = '';
  let deepgramWs;

  ws.on('message', async (msg) => {
    const data = JSON.parse(msg);
    if (data.event === 'start') {
      callSid = data.start.callSid;
      console.log('🔔 Call Started: ' + callSid);

      // Connect to Deepgram
      deepgramWs = new WebSocket(`wss://api.deepgram.com/v1/listen?punctuate=true`, {
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
        }
      });

      deepgramWs.on('message', async (dgData) => {
        const dgJson = JSON.parse(dgData);
        const transcript = dgJson.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.length > 0) {
          console.log('📝 Transcript: ' + transcript);
          if (!activeTranscripts[callSid]) {
            activeTranscripts[callSid] = { transcript: '', suggestions: [] };
          }

          // Append
          activeTranscripts[callSid].transcript += ' ' + transcript;

          // Get suggestions from OpenAI
          const prompt = `Agent script: Welcome! How can I help?\nCustomer said: ${transcript}\n\nBased on this, suggest how the agent should respond.`;
          const openaiResp = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
              model: process.env.OPENAI_MODEL,
              messages: [{ role: 'user', content: prompt }]
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
              }
            }
          );

          const suggestion = openaiResp.data.choices?.[0]?.message?.content;
          console.log('💡 Suggestion: ' + suggestion);

          activeTranscripts[callSid].suggestions.push(suggestion);

          // TODO: (optional) Send suggestion to Salesforce in real-time
        }
      });
    }

    // Audio stream
    if (data.event === 'media' && deepgramWs?.readyState === 1) {
      const audio = Buffer.from(data.media.payload, 'base64');
      deepgramWs.send(audio);
    }

    // End of Call
    if (data.event === 'stop') {
      console.log('🛑 Call Ended: ' + callSid);

      if (deepgramWs?.readyState === 1) {
        deepgramWs.close();
      }

      const fullTranscript = activeTranscripts[callSid]?.transcript || '';
      const suggestions = activeTranscripts[callSid]?.suggestions?.join('\n\n') || '';

      // 🔁 Store in Salesforce (Task)
      try {
        await axios.post(
          `${process.env.SF_INSTANCE_URL}/services/apexrest/transcript/save`,
          {
            callSid,
            transcript: fullTranscript,
            suggestions
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log('✅ Transcript sent to Salesforce');
      } catch (e) {
        console.error('❌ Salesforce POST failed', e.message);
      }

      delete activeTranscripts[callSid];
    }
  });
});

const server = app.listen(port, () => {
  console.log(`🌐 Server running on port ${port}`);
});

// Handle Twilio WebSocket Upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, function done(ws) {
    wss.emit('connection', ws, request);
  });
});
