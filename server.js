/******************************************************
 * server.js
 *
 * Provides OAuth routes to authorize and store tokens
 * for accessing Google Calendar.
 * Defines a /tool-call POST route for your AI (Vapi)
 * to invoke a "scheduleAppointment" function.
 ******************************************************/

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

/** 
 * 1) Set Your OAuth2 Credentials 
 *    (Update these with your real values from Google Cloud Console)
 */
const CLIENT_ID = '580600650779-7pkbilqsqc3bjs3d103umpg9h0djomv1.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

/**
 * 2) Set the Redirect URI
 *    Must match the "Authorized redirect URI" in Google Cloud Console.
 */
const REDIRECT_URI = 'https://vapifunctions.onrender.com/oauth2callback';

/**
 * 3) Path to store the tokens file on the server.
 *    If your environment is ephemeral (e.g., Render without a persistent disk),
 *    you'll lose this file on each restart or deploy. Plan accordingly.
 */
const TOKEN_PATH = path.join(__dirname, 'token.json');

/**
 * 4) Scopes for Google Calendar Access
 */
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

/**
 * 5) Express Setup
 */
const app = express();
app.use(bodyParser.json());

/**
 * 6) Port Configuration
 *    Render sets PORT via environment; fallback to 3000 locally.
 */
const port = process.env.PORT || 3000;

/**
 * Health Check: GET /
 */
app.get('/', (req, res) => {
  res.send('AI Voice Agent Calendar Scheduler is up and running!');
});

/**
 * 7) Start OAuth Flow: GET /auth
 *    - Direct user/admin to visit this URL to grant Calendar permissions.
 */
app.get('/auth', (req, res) => {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  // Generate the URL to request access
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline', // offline for refresh token
    scope: SCOPES
  });

  console.log('Authorize this app by visiting:', authUrl);
  // Redirect user to Google's OAuth2 consent screen
  res.redirect(authUrl);
});

/**
 * 8) OAuth Callback: GET /oauth2callback
 *    - Google redirects here with ?code=xxx after user consents.
 *    - We exchange that code for tokens and store them in token.json.
 */
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code parameter.');
  }

  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  try {
    // Exchange the authorization code for tokens
    const { tokens } = await oAuth2Client.getToken(code);
    // Save tokens to a file or DB
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Tokens acquired and saved to', TOKEN_PATH);

    res.send('Authentication successful! You can close this tab now.');
  } catch (err) {
    console.error('Error retrieving access token:', err);
    res.status(500).send('Error retrieving access token. Check logs.');
  }
});

/**
 * 9) The /tool-call Endpoint (POST)
 *    - Your AI (Vapi) will call this to schedule appointments.
 */
app.post('/tool-call', async (req, res) => {
  try {
    console.log('Incoming /tool-call data:', JSON.stringify(req.body, null, 2));

    // Vapi's function call data is nested under message.functionCall
    const functionCall = req.body?.message?.functionCall || {};
    const functionName = functionCall.name;
    const parameters = functionCall.parameters;
    // Optionally generate an ID if the AI doesn't provide one
    const toolCallId = 'auto_' + Date.now();

    let resultData;
    switch (functionName) {
      case 'scheduleAppointment':
        resultData = await scheduleAppointment(parameters);
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
 * 10) scheduleAppointment Function
 *     - Actually creates the event in Google Calendar.
 */
async function scheduleAppointment(params) {
  /**
   * Expected shape of params:
   * {
   *   "summary": "Some Title",
   *   "location": "123 Street or phone #",
   *   "description": "Extra details here",
   *   "startTime": "2025-02-10T10:00:00",
   *   "endTime": "2025-02-10T11:00:00"
   * }
   */

  // Check if we have stored OAuth tokens
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('No stored OAuth tokens found. Please visit /auth to authenticate first.');
  }

  // Load tokens
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

  // Create an OAuth2 client & set credentials
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials(tokens);

  // Initialize Google Calendar
  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  // Build the event
  const event = {
    summary: params.summary || 'New Appointment',
    location: params.location || '',
    description: params.description || '',
    start: {
      dateTime: params.startTime,
      timeZone: 'America/New_York' // Adjust if needed
    },
    end: {
      dateTime: params.endTime,
      timeZone: 'America/New_York'
    }
  };

  try {
    // Insert into the primary calendar
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
 * 11) Start the Server
 */
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
  console.log(`Visit https://vapifunctions.onrender.com/auth to begin OAuth flow in production.`);
});
