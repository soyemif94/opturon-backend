const env = require('../config/env');

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function sanitizeReplyText(input) {
  const cleaned = String(input || '')
    .replace(/```/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  return cleaned.slice(0, 280);
}

function extractReplyTextFromModel(content) {
  const rawContent = String(content || '').trim();
  if (!rawContent) {
    return '';
  }

  const parsedJson = safeJsonParse(rawContent);
  if (parsedJson && typeof parsedJson === 'object' && parsedJson.replyText !== undefined) {
    return sanitizeReplyText(parsedJson.replyText);
  }

  return sanitizeReplyText(rawContent);
}

async function generateReply({ systemPrompt, messages, model, timeoutMs }) {
  const apiKey = String(env.openaiApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const finalModel = String(model || env.openaiModel || 'gpt-4o-mini').trim();
  const finalTimeoutMs = Number(timeoutMs || env.openaiTimeoutMs || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), finalTimeoutMs);

  const payload = {
    model: finalModel,
    messages: [{ role: 'system', content: String(systemPrompt || '').trim() }, ...(Array.isArray(messages) ? messages : [])],
    temperature: 0.4,
    max_tokens: 220
  };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    const json = safeJsonParse(raw);

    if (!response.ok) {
      const message =
        (json && json.error && json.error.message) ||
        `OpenAI request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.raw = raw;
      throw error;
    }

    const content = String(
      (json &&
        json.choices &&
        json.choices[0] &&
        json.choices[0].message &&
        json.choices[0].message.content) ||
        ''
    );
    const replyText = extractReplyTextFromModel(content);

    if (!replyText) {
      const error = new Error('OpenAI returned empty reply');
      error.status = response.status;
      error.raw = raw;
      throw error;
    }

    return {
      replyText,
      model: finalModel,
      usage: json && json.usage ? json.usage : null,
      raw
    };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`OpenAI request timeout after ${finalTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  generateReply
};
