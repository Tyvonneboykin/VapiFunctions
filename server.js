/******************************************************
 * server.js
 *
 * 1) Provides OAuth routes to authorize and store tokens
 *    for accessing Google Calendar.
 * 2) Defines a /tool-call POST route for your AI (Vapi)
 *    to invoke a "scheduleAppointment" function.
 * 3) Adds a sendSMS function to deliver text messages
 *    via Twilio.
 * 4) Automated client onboarding system with payment
 *    integration and workflow generation.
 ******************************************************/

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const crypto = require('crypto');

// -- ADD TWILIO --
const twilio = require('twilio');


// Twilio Credentials from Environment Variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const twilioClient = require('twilio')(accountSid, authToken);

// Vapi API Configuration
const VAPI_API_KEY = process.env.VAPI_API_KEY || 'de4d12ac-3858-43f6-b7e1-defc71fafaa5';
const VAPI_API_BASE = 'https://api.vapi.ai';

// Stripe Configuration (for payment processing)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Client Database Storage (simple file-based for now)
const CLIENTS_DB_PATH = path.join(__dirname, 'clients.json');

// Initialize clients database if it doesn't exist
if (!fs.existsSync(CLIENTS_DB_PATH)) {
  fs.writeFileSync(CLIENTS_DB_PATH, JSON.stringify({}));
}


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
 * CLIENT ONBOARDING SYSTEM ENDPOINTS
 */

/**
 * Generate payment link for client onboarding
 */
app.post('/create-payment-link', async (req, res) => {
  try {
    const { clientName, clientPhone, clientEmail, amount, businessName } = req.body;
    
    if (!clientName || !clientPhone || !amount) {
      return res.status(400).json({ error: 'Missing required fields: clientName, clientPhone, amount' });
    }

    // Generate client ID
    const clientId = 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Store client data (temporarily until payment)
    const clientData = {
      clientId,
      clientName,
      clientPhone,
      clientEmail: clientEmail || null,
      businessName: businessName || null,
      amount,
      paymentStatus: 'pending',
      createdAt: new Date().toISOString()
    };
    
    // Save to database
    const clients = JSON.parse(fs.readFileSync(CLIENTS_DB_PATH, 'utf8'));
    clients[clientId] = clientData;
    fs.writeFileSync(CLIENTS_DB_PATH, JSON.stringify(clients, null, 2));
    
    // For now, create a mock payment link (replace with actual Stripe integration)
    const paymentLink = `https://checkout.stripe.com/pay/mock-${clientId}#fidkdWxOYHwnPyd1blpxYHZxWnFgVTUwSE5`;
    
    // Send payment link via SMS
    try {
      const smsMessage = await twilioClient.messages.create({
        body: `Hi ${clientName}! Thanks for choosing our AI assistant service. 

Your payment link: ${paymentLink}

Amount: $${amount}
Business: ${businessName || 'Your Business'}

Complete payment to activate your 24/7 AI phone system!

Questions? Reply to this message.`,
        from: '+18557442080',
        to: clientPhone
      });
      
      console.log(`Payment link SMS sent to ${clientName}: ${smsMessage.sid}`);
    } catch (smsError) {
      console.error('Error sending payment link SMS:', smsError);
    }
    
    res.json({
      success: true,
      clientId,
      paymentLink,
      message: `Payment link sent to ${clientPhone}`
    });
    
  } catch (error) {
    console.error('Error creating payment link:', error);
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

/**
 * Stripe webhook for payment confirmation
 */
app.post('/webhook/payment-confirmed', async (req, res) => {
  try {
    // Mock payment confirmation (replace with actual Stripe webhook handling)
    const { clientId, paymentIntentId } = req.body;
    
    if (!clientId) {
      return res.status(400).json({ error: 'Missing clientId' });
    }
    
    // Update client payment status
    const clients = JSON.parse(fs.readFileSync(CLIENTS_DB_PATH, 'utf8'));
    const client = clients[clientId];
    
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    
    client.paymentStatus = 'completed';
    client.paymentIntentId = paymentIntentId;
    client.paidAt = new Date().toISOString();
    
    // Generate workflow and assign phone number
    try {
      const workflowResult = await generateClientWorkflow(client);
      client.workflowId = workflowResult.workflowId;
      client.assignedPhoneNumber = workflowResult.phoneNumber;
      
      // Save updated client data
      clients[clientId] = client;
      fs.writeFileSync(CLIENTS_DB_PATH, JSON.stringify(clients, null, 2));
      
      // Notify client of their new business phone system
      await notifyClientActivation(client);
      
      console.log(`Client ${clientId} workflow activated: ${workflowResult.workflowId}`);
      
    } catch (workflowError) {
      console.error('Error generating workflow:', workflowError);
      client.workflowStatus = 'failed';
      client.workflowError = workflowError.message;
      clients[clientId] = client;
      fs.writeFileSync(CLIENTS_DB_PATH, JSON.stringify(clients, null, 2));
    }
    
    res.json({ success: true, clientId, status: client.paymentStatus });
    
  } catch (error) {
    console.error('Error processing payment webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * Generate client workflow and assign phone number
 */
async function generateClientWorkflow(clientData) {
  try {
    // Create custom workflow based on template
    const workflowTemplate = createWorkflowTemplate(clientData);
    
    // Create workflow via Vapi API
    const workflowResponse = await fetch(`${VAPI_API_BASE}/workflow`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(workflowTemplate)
    });
    
    if (!workflowResponse.ok) {
      throw new Error(`Workflow creation failed: ${workflowResponse.statusText}`);
    }
    
    const workflow = await workflowResponse.json();
    
    // Assign phone number (mock for now - replace with actual Vapi phone assignment)
    const phoneNumber = generateMockPhoneNumber();
    
    return {
      workflowId: workflow.id,
      phoneNumber: phoneNumber
    };
    
  } catch (error) {
    console.error('Error generating workflow:', error);
    throw error;
  }
}

/**
 * Create workflow template based on client data
 */
function createWorkflowTemplate(clientData) {
  const businessName = clientData.businessName || clientData.clientName + "'s Business";
  
  return {
    name: `${businessName} - AI Assistant`,
    nodes: [
      {
        name: "start",
        type: "conversation",
        model: {
          model: "gpt-4o",
          provider: "openai",
          maxTokens: 1000,
          temperature: 0.7
        },
        voice: {
          voiceId: "Kylie",
          provider: "vapi"
        },
        prompt: `You are the AI assistant for ${businessName}. Current date/time is {{\"now\" | date: \"%A, %B %d, %Y at %I:%M %p\", \"America/New_York\"}}. Thank you for calling ${businessName}. How may I help you today?`,
        isStart: true,
        metadata: { position: { x: 0, y: 0 } },
        messagePlan: {
          firstMessage: `Hello! Thank you for calling ${businessName}. How can I assist you today?`
        }
      },
      {
        name: "general_assistance",
        type: "conversation",
        model: {
          model: "gpt-4o", 
          provider: "openai",
          maxTokens: 1000,
          temperature: 0.7
        },
        voice: {
          voiceId: "Kylie",
          provider: "vapi"
        },
        prompt: `Provide helpful assistance for ${businessName}. If the caller needs to schedule an appointment or needs specific help, offer to connect them with someone or take their information for follow-up.`,
        metadata: { position: { x: 300, y: 0 } },
        messagePlan: { firstMessage: "" },
        variableExtractionPlan: {
          output: [
            { enum: ["schedule", "information", "support"], type: "string", title: "request_type", description: "Type of assistance needed" }
          ]
        }
      },
      {
        name: "collect_contact",
        type: "conversation", 
        model: {
          model: "gpt-4o",
          provider: "openai", 
          maxTokens: 1000,
          temperature: 0.7
        },
        voice: {
          voiceId: "Kylie",
          provider: "vapi"
        },
        prompt: `Collect the caller's contact information for follow-up. Ask for their name and the best phone number to reach them.`,
        metadata: { position: { x: 600, y: 0 } },
        messagePlan: { firstMessage: "" },
        variableExtractionPlan: {
          output: [
            { enum: [], type: "string", title: "caller_name", description: "Caller's name" },
            { enum: [], type: "string", title: "caller_phone", description: "Caller's phone number" }
          ]
        }
      },
      {
        name: "sendSMS",
        type: "tool",
        toolId: "ea06a31a-6291-4dd7-bc46-8b1ebd79875d",
        metadata: { position: { x: 900, y: 0 } }
      },
      {
        name: "hangup_final",
        tool: {
          type: "endCall",
          function: { name: "untitled_tool", parameters: { type: "object", required: [], properties: {} } },
          messages: [{ type: "request-start", content: `Thank you for calling ${businessName}. Have a wonderful day!`, blocking: true }]
        },
        type: "tool",
        metadata: { position: { x: 1200, y: 0 } }
      }
    ],
    edges: [
      { from: "start", to: "general_assistance", condition: { type: "ai", prompt: "User needs assistance" } },
      { from: "general_assistance", to: "collect_contact", condition: { type: "ai", prompt: "User needs follow-up or appointment" } },
      { from: "collect_contact", to: "sendSMS", condition: { type: "ai", prompt: "Contact information collected" } },
      { from: "sendSMS", to: "hangup_final", condition: { type: "ai", prompt: "SMS sent successfully" } },
      { from: "general_assistance", to: "hangup_final", condition: { type: "ai", prompt: "User got the information they needed" } }
    ],
    globalPrompt: `You are the professional AI assistant for ${businessName}. Be helpful, courteous, and professional. Always try to assist callers or collect their information for follow-up.`
  };
}

/**
 * Generate mock phone number (replace with actual Vapi phone assignment)
 */
function generateMockPhoneNumber() {
  const areaCode = '855';
  const exchange = Math.floor(Math.random() * 900) + 100;
  const number = Math.floor(Math.random() * 9000) + 1000;
  return `+1${areaCode}${exchange}${number}`;
}

/**
 * Notify client of system activation
 */
async function notifyClientActivation(clientData) {
  try {
    const message = await twilioClient.messages.create({
      body: `🎉 Your AI assistant is now LIVE!

Business: ${clientData.businessName || clientData.clientName + "'s Business"}
Your AI Phone: ${clientData.assignedPhoneNumber}

Your customers can now call this number 24/7 and speak with your professional AI assistant!

Test it yourself by calling from a different phone.

Questions? Reply to this message.

Welcome to the future of customer service!`,
      from: '+18557442080',
      to: clientData.clientPhone
    });
    
    console.log(`Activation SMS sent to ${clientData.clientName}: ${message.sid}`);
    return message.sid;
    
  } catch (error) {
    console.error('Error sending activation SMS:', error);
    throw error;
  }
}

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
      case 'createPaymentLink': // NEW: Jane assistant payment link generation
        resultData = await createPaymentLinkFunction(parameters);
        break;
      case 'summarizeClientCall': // NEW: Summarize client conversation
        resultData = await summarizeClientCallFunction(parameters);
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

    // Send SMS to customer
    const customerMessage = await twilioClient.messages.create({
      body: messageBody,
      from: '+18557442080', // Your Twilio number
      to: to
    });
    
    let ownerMessage = null;
    
    // If this is an appointment confirmation, also notify the business owner
    if (customerName && appointmentType && selectedDate && selectedTime) {
      const ownerMessageBody = `New Appointment Scheduled!

Customer: ${customerName}
Service: ${appointmentType}
Date: ${selectedDate} at ${selectedTime}
Address: ${propertyAddress || 'Customer Property'}

Add to Calendar: ${createAddToCalendarLink({
        title: `Green Glow Gardens - ${appointmentType}`,
        description: `${appointmentType} appointment with Green Glow Gardens. Customer: ${customerName}. Address: ${propertyAddress || 'Customer Property'}`,
        location: propertyAddress || 'Customer Property',
        startDate: selectedDate,
        startTime: selectedTime
      })}

- Green Glow Gardens Scheduling System`;

      try {
        ownerMessage = await twilioClient.messages.create({
          body: ownerMessageBody,
          from: '+18557442080',
          to: '+19736661635' // Business owner's phone number
        });
      } catch (ownerErr) {
        console.error('Error sending owner notification SMS:', ownerErr);
        // Don't fail the whole operation if owner SMS fails
      }
    }
    
    if (customerName) {
      const ownerStatus = ownerMessage ? ` Owner notified: ${ownerMessage.sid}` : ' (Owner notification failed)';
      return `Appointment SMS sent to ${customerName}! Customer SID: ${customerMessage.sid}.${ownerStatus}`;
    } else {
      return `SMS sent successfully! SID: ${customerMessage.sid}`;
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

/**
 * Function: createPaymentLinkFunction
 * Creates payment link for client onboarding (called by Jane assistant)
 */
async function createPaymentLinkFunction(params) {
  try {
    const { clientName, clientPhone, clientEmail, amount, businessName, businessType } = params;
    
    if (!clientName || !clientPhone || !amount) {
      throw new Error('Missing required parameters: clientName, clientPhone, amount');
    }
    
    // Call the payment link creation endpoint
    const response = await fetch('https://vapifunctions.onrender.com/create-payment-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientName,
        clientPhone,
        clientEmail,
        amount,
        businessName,
        businessType
      })
    });
    
    if (!response.ok) {
      throw new Error(`Payment link creation failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    return `Payment link created and sent to ${clientName} at ${clientPhone}. Client ID: ${result.clientId}. Amount: $${amount}`;
    
  } catch (error) {
    console.error('Error in createPaymentLinkFunction:', error);
    throw new Error(`Could not create payment link: ${error.message}`);
  }
}

/**
 * Function: summarizeClientCallFunction  
 * Summarizes client call data for workflow generation
 */
async function summarizeClientCallFunction(params) {
  try {
    const { clientName, businessName, businessType, services, budget, timeline, notes } = params;
    
    const summary = {
      clientName: clientName || 'Unknown',
      businessName: businessName || clientName + "'s Business",
      businessType: businessType || 'general',
      services: services || [],
      budget: budget || 'not specified',
      timeline: timeline || 'flexible',
      notes: notes || '',
      summarizedAt: new Date().toISOString()
    };
    
    // Store summary for later use in workflow generation
    const summaryId = 'summary_' + Date.now();
    const summariesPath = path.join(__dirname, 'call_summaries.json');
    
    let summaries = {};
    if (fs.existsSync(summariesPath)) {
      summaries = JSON.parse(fs.readFileSync(summariesPath, 'utf8'));
    }
    
    summaries[summaryId] = summary;
    fs.writeFileSync(summariesPath, JSON.stringify(summaries, null, 2));
    
    return `Call summary created for ${clientName}. Summary ID: ${summaryId}. Business: ${businessName}, Type: ${businessType}`;
    
  } catch (error) {
    console.error('Error in summarizeClientCallFunction:', error);
    throw new Error(`Could not create call summary: ${error.message}`);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
  console.log(`Visit https://vapifunctions.onrender.com/auth to begin OAuth flow in production.`);
});
