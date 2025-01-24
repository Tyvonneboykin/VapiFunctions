/******************************************************
 * server.js
 *
 * 1) Provides OAuth routes to authorize and store tokens
 *    so we can access Google Calendar.
 * 2) Defines a /tool-call POST route for your AI (Vapi)
 *    to invoke a "scheduleAppointment" function.
 ******************************************************/

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');

// -- REPLACE with your actual OAuth2 credentials --
const CLIENT_ID = '580600650779-7pkbilqsqc3bjs3d103umpg9h0djomv1.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

// IMPORTANT: This must match the "Authorized redirect URI" you set in your
// Google Cloud Console for the above CLIENT_ID. If you're deploying on Render,
// set it to: https://<your-app-name>.onrender.com/oauth2callback
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// The file where we store/refresh the user's tokens.
// For persistent storage on Render, you may need a persistent disk or store tokens in a DB.
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Scope for read/write access to Google Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Create the Express app
const app = express();
app.use(bodyParser.json());

// The port Render provides via environment variable, or fallback to 3000 locally
const port = process.env.PORT || 3000;

//============================================================
// 1) Health check (root path)
//============================================================
app.get('/', (req, res) => {
  res.send('AI Voice Agent Calendar Scheduler is running!');
});

//============================================================
// 2) Start OAuth flow: GET /auth
//============================================================
app.get('/auth', (req, res) => {
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  // Generate an OAuth URL for the user to visit and grant access.
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });

  console.log('Authorize this app by visiting:', authUrl);
  // Redirect the user to Google's OAuth 2.0 server:
  res.redirect(authUrl);
});

//============================================================
// 3) OAuth callback: GET /oauth2callback
//    Google redirects here with ?code=xxx after user consents
//============================================================
app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing code parameter.');
  }

  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

  try {
    // Exchange the authorization code for tokens
    const { tokens } = await oAuth2Client.getToken(code);

    // Save tokens to a local file (or DB) so we can use them for future requests
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Tokens acquired and saved to', TOKEN_PATH);

    res.send('Authentication successful! You can close this tab and make requests now.');
  } catch (err) {
    console.error('Error retrieving access token', err);
    res.status(500).send('Error retrieving access token. Check logs.');
  }
});

//============================================================
// 4) The /tool-call endpoint for your AI (Vapi) calls
//============================================================
app.post('/tool-call', async (req, res) => {
  try {
    console.log('Incoming /tool-call data:', JSON.stringify(req.body, null, 2));

    // The AI's function call data is now nested under message.functionCall
    const functionCall = req.body?.message?.functionCall || {};
    const functionName = functionCall.name;
    const parameters = functionCall.parameters;

    // If you need a unique ID, generate one (the AI might not provide one)
    const toolCallId = 'auto_' + Date.now();

    let resultData;
    switch (functionName) {
      case 'scheduleAppointment':
        // Call our scheduling function with the parameters
        resultData = await scheduleAppointment(parameters);
        break;
      default:
        // If no recognized function name
        resultData = `No handler for function: ${functionName}`;
    }

    // Respond in the (Vapi) expected format
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

//============================================================
// 5) scheduleAppointment function
//    Actually creates an event in Google Calendar
//============================================================
async function scheduleAppointment(params) {
  /*
    Example shape of params (from AI):
    {
      "summary": "Dentist Appointment",
      "location": "1234 Example St.",
      "description": "Regular check-up",
      "startTime": "2025-02-10T10:00:00",
      "endTime": "2025-02-10T11:00:00"
    }
  */

  // 1) Load tokens from file:
  let tokens;
  if (fs.existsSync(TOKEN_PATH)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } else {
    throw new Error('No stored OAuth tokens found. Please visit /auth to authenticate first.');
  }

  // 2) Setup OAuth2 client
  const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  oAuth2Client.setCredentials(tokens);

  // 3) Create the calendar client
  const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });

  // 4) Define the event
  const event = {
    summary: params.summary || 'New Appointment',
    location: params.location || '',
    description: params.description || '',
    start: {
      dateTime: params.startTime,
      timeZone: 'America/New_York'  // Adjust as needed
    },
    end: {
      dateTime: params.endTime,
      timeZone: 'America/New_York'
    }
  };

  try {
    // 5) Insert event into "primary" calendar (the account used for OAuth)
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

//============================================================
// 6) Start the server
//============================================================
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
  console.log(`Visit http://localhost:${port}/auth to initiate OAuth (locally).`);
});
