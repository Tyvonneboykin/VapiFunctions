// index.js
const express = require('express');
const bodyParser = require('body-parser');
const app = express();

// Use the PORT Render provides or default to 3000
const port = process.env.PORT || 3000;

// Parse incoming JSON
app.use(bodyParser.json());

// Health check route
app.get('/', (req, res) => {
  res.send('Tools Calling Server is up and running!');
});

// Main endpoint that Vapi (or other clients) will POST to
app.post('/tool-call', async (req, res) => {
  try {
    // Log the entire incoming request body for debugging
    console.log('Incoming /tool-call data:', req.body);

    // Destructure data (example structure)
    const { toolCallId, function: functionData, parameters } = req.body;

    let resultData;
    switch (functionData?.name) {
      case 'get_weather':
        resultData = await getWeather(parameters.location);
        break;
      case 'some_other_tool':
        resultData = await someOtherFunction(parameters);
        break;
      default:
        // If no recognized function name
        resultData = `No handler for function: ${functionData?.name}`;
    }

    // Return data in the format the AI expects
    const responsePayload = {
      results: [
        {
          toolCallId: toolCallId,
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
          toolCallId: req.body?.toolCallId || null,
          result: `Error: ${error.message}`
        }
      ]
    });
  }
});

// Example “getWeather” function
async function getWeather(location) {
  // For now, just return a mock response
  return `Mock weather for ${location} is 72°F and sunny.`;
}

// Example “someOtherFunction”
async function someOtherFunction(parameters) {
  return `Executed someOtherFunction with parameters: ${JSON.stringify(parameters)}`;
}

// Start listening
app.listen(port, () => {
  console.log(`Tools server listening on port ${port}`);
});
