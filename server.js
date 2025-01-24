/******************************************************
 * server.js
 *
 * 1) Provides OAuth routes to authorize and store tokens
 *    for accessing Google Calendar.
 * 2) Defines a /tool-call POST route for your AI (Vapi)
 *    to invoke a "scheduleAppointment" function.
 * 3) Adds a sendSMS function to deliver text messages
 *    via Twilio.
 ******************************************************/

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// -- ADD TWILIO --
const twilio = require('twilio');


// Twilio Credentials from Environment Variables
// Replace the fallback strings ('ACxxxxx', '[AuthToken]') if you'd like a non-env fallback, 
// but ideally you rely solely on process.env for security.
const accountSid = process.env.TWILIO_ACCOUNT_SID || 'AC3661b0771f1e1faa2a9ea9532bc698ca';
const authToken  = process.env.TWILIO_AUTH_TOKEN  || '5c027f6f6eda7b1fb41b4c7418edbc80'; 

const twilioClient = require('twilio')(accountSid, authToken);

// Export the client if needed in other modules
module.exports = twilioClient;


/** 
 * Google OAuth Credentials
 */
const CLIENT_ID = '580600650779-7pkbilqsqc3bjs3d103umpg9h0djomv1.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REDIRECT_URI = 'https://vapifunctions.onrender.com/oauth2callback';

// File path for saving tokens
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Express setup
const app = express();
app.use(bodyParser.json());
const port = process.env.PORT || 3000;

/**
 * Health check
 */
app.get('/', (req, res) => {
  res.send('AI Voice Agent Scheduler + SMS is running!');
});

/**
 * Start OAuth flow
 */
app.get('/auth', (req, res) => {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  console.log('Authorize this app by visiting:', authUrl);
  res.redirect(authUrl);
});

/**
 * OAuth callback
 */
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code parameter.');
  }

  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Tokens acquired and saved to', TOKEN_PATH);
    res.send('Authentication successful! You can close this tab now.');
  } catch (err) {
    console.error('Error retrieving access token:', err);
    res.status(500).send('Error retrieving access token. Check logs.');
  }
});

/**
 * MAIN ENDPOINT: /tool-call
 */
app.post('/tool-call', async (req, res) => {
  try {
    console.log('Incoming /tool-call data:', JSON.stringify(req.body, null, 2));

    // AI function call data
    const functionCall = req.body?.message?.functionCall || {};
    const functionName = functionCall.name;
    const parameters = functionCall.parameters;

    // Generate an ID if not provided
    const toolCallId = 'auto_' + Date.now();

    let resultData;
    switch (functionName) {
      case 'scheduleAppointment':
        resultData = await scheduleAppointment(parameters);
        break;
      case 'sendSMS': // NEW CASE
        resultData = await sendSMSFunction(parameters);
        break;
      default:
        resultData = `No handler for function: ${functionName}`;
    }

    // Respond in the format Vapi expects
    const responsePayload = {
      results: [
        {
          toolCallId,
          result: resultData
        }
      ]
    };
    return res.json(responsePayload);

  } catch (error) {
    console.error('Tool call error:', error);
    return res.status(500).json({
      results: [
        {
          toolCallId: null,
          result: `Error: ${error.message}`
        }
      ]
    });
  }
});

/**
 * Function: scheduleAppointment
 * Creates an event in Google Calendar
 */
async function scheduleAppointment(params) {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('No stored OAuth tokens found. Please visit /auth first.');
  }

  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
  const event = {
    summary: params.summary || 'New Appointment',
    location: params.location || '',
    description: params.description || '',
    start: {
      dateTime: params.startTime,
      timeZone: 'America/New_York'
    },
    end: {
      dateTime: params.endTime,
      timeZone: 'America/New_York'
    }
  };

  try {
    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event
    });
    if (response?.data?.htmlLink) {
      return `Appointment scheduled successfully! See details: ${response.data.htmlLink}`;
    } else {
      return 'Appointment scheduled, but no event link available.';
    }
  } catch (err) {
    console.error('Error scheduling appointment:', err);
    throw new Error(`Could not schedule appointment: ${err.message}`);
  }
}

/**
 * Function: sendSMSFunction
 * Sends an SMS using Twilio
 */
async function sendSMSFunction(params) {
  /**
   * Expected shape of params:
   * {
   *   "to": "+12345556789",
   *   "body": "Hello, thanks for signing up! Here's your link..."
   * }
   */
  const { to, body } = params;
  if (!to || !body) {
    throw new Error('Missing SMS "to" or "body" parameter.');
  }

  try {
    const message = await twilioClient.messages.create({
      body: body,
      from: '+18557442080', // Your Twilio number
      to: to
    });
    return `SMS sent successfully! SID: ${message.sid}`;
  } catch (err) {
    console.error('Error sending SMS:', err);
    throw new Error(`Could not send SMS: ${err.message}`);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
  console.log(`Visit https://vapifunctions.onrender.com/auth to begin OAuth flow in production.`);
});
