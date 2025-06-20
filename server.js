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
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;

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
 * Sends an SMS using Twilio with optional calendar integration
 */
async function sendSMSFunction(params) {
  const { to, body, customerName, appointmentType, selectedDate, selectedTime, propertyAddress } = params;
  
  if (!to) {
    throw new Error('Missing SMS "to" parameter.');
  }

  try {
    let messageBody;
    
    // Check if this is an appointment confirmation (new format) or simple SMS (old format)
    if (customerName && appointmentType && selectedDate && selectedTime) {
      // New format - create appointment confirmation with calendar link
      const calendarLink = createAddToCalendarLink({
        title: `Green Glow Gardens - ${appointmentType}`,
        description: `${appointmentType} appointment with Green Glow Gardens. Our professional will arrive 15 minutes early to survey your property.`,
        location: propertyAddress || 'Customer Property',
        startDate: selectedDate,
        startTime: selectedTime
      });

      messageBody = `Green Glow Gardens Confirmation!

Hi ${customerName}! Your ${appointmentType} is confirmed for ${selectedDate} at ${selectedTime}.

Our team arrives 15 min early to survey your property.

Add to Calendar: ${calendarLink}

Questions? Call us anytime!
- Jane at Green Glow Gardens`;
    } else if (body) {
      // Old format - just send the message as-is
      messageBody = body;
    } else {
      throw new Error('Missing SMS parameters. Need either "body" or appointment details.');
    }

    const message = await twilioClient.messages.create({
      body: messageBody,
      from: '+18557442080', // Your Twilio number
      to: to
    });
    
    if (customerName) {
      return `Appointment SMS sent to ${customerName}! SID: ${message.sid}`;
    } else {
      return `SMS sent successfully! SID: ${message.sid}`;
    }
  } catch (err) {
    console.error('Error sending SMS:', err);
    throw new Error(`Could not send SMS: ${err.message}`);
  }
}

/**
 * Helper function to create "Add to Calendar" link for Google Calendar
 */
function createAddToCalendarLink({ title, description, location, startDate, startTime }) {
  try {
    // Convert date/time to the format needed for Google Calendar
    const dateTimeString = convertToCalendarDateTime(startDate, startTime);
    const endDateTime = addOneHour(dateTimeString);
    
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: `${dateTimeString}/${endDateTime}`,
      details: description,
      location: location || '',
      trp: 'false'
    });

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  } catch (error) {
    console.error('Error creating calendar link:', error);
    return 'https://calendar.google.com/calendar'; // Fallback to basic calendar
  }
}

/**
 * Helper function to convert date/time to Google Calendar format (YYYYMMDDTHHMMSSZ)
 */
function convertToCalendarDateTime(date, time) {
  try {
    // Handle various date formats
    let dateStr = date;
    let timeStr = time;
    
    // Clean up the date string
    if (typeof dateStr === 'string') {
      dateStr = dateStr.replace(/,/g, '').trim();
    }
    
    // Parse the date and time
    const dateTimeStr = `${dateStr} ${timeStr}`;
    const dateObj = new Date(dateTimeStr);
    
    // Check if date is valid
    if (isNaN(dateObj.getTime())) {
      throw new Error('Invalid date/time format');
    }
    
    // Convert to local time format for Google Calendar (no timezone conversion)
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    
    return `${year}${month}${day}T${hours}${minutes}00`;
  } catch (error) {
    console.error('Error converting date/time:', error);
    
    // Fallback to tomorrow at 2 PM
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0);
    
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    
    return `${year}${month}${day}T140000`;
  }
}

/**
 * Helper function to add one hour to a datetime string
 */
function addOneHour(dateTimeString) {
  try {
    const year = parseInt(dateTimeString.substring(0, 4));
    const month = parseInt(dateTimeString.substring(4, 6)) - 1; // Month is 0-indexed
    const day = parseInt(dateTimeString.substring(6, 8));
    const hour = parseInt(dateTimeString.substring(9, 11));
    const minute = parseInt(dateTimeString.substring(11, 13));
    
    const date = new Date(year, month, day, hour, minute);
    date.setHours(date.getHours() + 1);
    
    const newYear = date.getFullYear();
    const newMonth = String(date.getMonth() + 1).padStart(2, '0');
    const newDay = String(date.getDate()).padStart(2, '0');
    const newHour = String(date.getHours()).padStart(2, '0');
    const newMinute = String(date.getMinutes()).padStart(2, '0');
    
    return `${newYear}${newMonth}${newDay}T${newHour}${newMinute}00`;
  } catch (error) {
    console.error('Error adding one hour:', error);
    // Fallback: return the original string
    return dateTimeString;
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
  console.log(`Visit https://vapifunctions.onrender.com/auth to begin OAuth flow in production.`);
});
