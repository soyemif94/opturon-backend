const OpenAI = require('openai');

const env = require('../config/env');
const { logWarn } = require('../utils/logger');

const DEFAULT_ANALYSIS = {
  patientStatus: 'new',
  treatmentType: 'consulta_general',
  urgencyLevel: 'medium',
  summary: 'Solicitud general de atencion odontologica',
  confidence: 0.5
};

const PROMPT = `Eres un clasificador para mensajes entrantes de una clinica odontologica.
Responde SOLO JSON valido, sin markdown.
Campos obligatorios:
- patientStatus: "new" o "existing"
- treatmentType: una etiqueta corta en snake_case (ej: limpieza, ortodoncia, dolor_molar, implante, extraccion, endodoncia, estetica, consulta_general)
- urgencyLevel: "low" | "medium" | "high" | "critical"
- summary: resumen breve en espanol
- confidence: numero entre 0 y 1`;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function normalizeAnalysis(result) {
  const patientStatus = result && result.patientStatus === 'existing' ? 'existing' : 'new';

  const urgencyAllowed = new Set(['low', 'medium', 'high', 'critical']);
  const urgencyLevel = urgencyAllowed.has(result && result.urgencyLevel) ? result.urgencyLevel : 'medium';

  const treatmentType =
    typeof (result && result.treatmentType) === 'string' && result.treatmentType.trim()
      ? result.treatmentType.trim().toLowerCase().replace(/\s+/g, '_')
      : 'consulta_general';

  const summary =
    typeof (result && result.summary) === 'string' && result.summary.trim()
      ? result.summary.trim()
      : 'Solicitud general de atencion odontologica';

  const confidenceRaw = Number(result && result.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.5;

  return { patientStatus, treatmentType, urgencyLevel, summary, confidence };
}

function heuristicAnalysis(payload) {
  const text = `${payload.message || ''} ${payload.patientId || ''}`.toLowerCase();

  const patientStatus = payload.patientId ? 'existing' : text.includes('ya soy paciente') ? 'existing' : 'new';

  let urgencyLevel = 'medium';
  if (/urgente|sangrado|insoportable|fiebre|inflamacion fuerte|trauma/.test(text)) urgencyLevel = 'critical';
  else if (/dolor fuerte|mucho dolor|hinchado|infeccion/.test(text)) urgencyLevel = 'high';
  else if (/consulta|cotizacion|precio/.test(text)) urgencyLevel = 'low';

  let treatmentType = 'consulta_general';
  if (/limpieza|profilaxis/.test(text)) treatmentType = 'limpieza';
  if (/brackets|ortodoncia/.test(text)) treatmentType = 'ortodoncia';
  if (/implante/.test(text)) treatmentType = 'implante';
  if (/extraccion|sacar muela/.test(text)) treatmentType = 'extraccion';
  if (/endodoncia|conducto/.test(text)) treatmentType = 'endodoncia';
  if (/caries|molar|muela|diente/.test(text)) treatmentType = 'dolor_molar';
  if (/blanqueamiento|estetica|carillas/.test(text)) treatmentType = 'estetica';

  return {
    patientStatus,
    treatmentType,
    urgencyLevel,
    summary: `Clasificacion por fallback para mensaje: ${payload.message || ''}`.trim(),
    confidence: 0.45
  };
}

async function analyzeMessage(payload) {
  if (!env.openaiApiKey) {
    return heuristicAnalysis(payload);
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });

  try {
    const completion = await client.chat.completions.create({
      model: env.openaiModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            name: payload.name || '',
            from: payload.from || '',
            patientId: payload.patientId || '',
            message: payload.message || ''
          })
        }
      ]
    });

    const content = completion.choices[0] && completion.choices[0].message ? completion.choices[0].message.content : '';
    const parsed = safeJsonParse(content);

    if (!parsed) {
      logWarn('OpenAI response could not be parsed, using default + heuristic merge');
      return { ...DEFAULT_ANALYSIS, ...heuristicAnalysis(payload) };
    }

    return normalizeAnalysis(parsed);
  } catch (error) {
    logWarn('OpenAI request failed, using heuristic fallback', { error: error.message });
    return heuristicAnalysis(payload);
  }
}

module.exports = { analyzeMessage };
