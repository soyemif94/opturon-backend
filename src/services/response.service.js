const OpenAI = require('openai');

const env = require('../config/env');

function urgencyLine(level) {
  if (level === 'critical') return 'Detectamos alta urgencia. Te recomendamos acudir hoy mismo.';
  if (level === 'high') return 'Vemos prioridad alta. Te ayudamos a agendar lo antes posible.';
  if (level === 'low') return 'Gracias por contactarnos. Te compartimos opciones de horario.';
  return 'Gracias por escribirnos, estamos revisando tu caso.';
}

function appointmentLine(appointment) {
  if (!appointment || !appointment.startAt) {
    return 'No hay turnos inmediatos confirmados por el momento, pero priorizaremos tu caso.';
  }

  return `Te confirmamos un turno prioritario para ${appointment.startAt}.`;
}

function templateReply({ name, analysis, appointment }) {
  const intro = name ? `Hola ${name},` : 'Hola,';
  const statusLine = analysis.patientStatus === 'existing' ? 'gracias por volver a la clinica.' : 'gracias por contactarnos por primera vez.';
  const urgent = analysis.urgencyLevel === 'high' || analysis.urgencyLevel === 'critical';
  const appointmentInfo = urgent ? ` ${appointmentLine(appointment)}` : '';

  return `${intro} ${statusLine} Recibimos tu solicitud sobre ${analysis.treatmentType.replace(/_/g, ' ')}. ${urgencyLine(analysis.urgencyLevel)}${appointmentInfo} Un asesor odontologico te contactara para seguimiento.`;
}

async function generateReply({ name, message, analysis, appointment }) {
  if (!env.openaiApiKey) {
    return templateReply({ name, analysis, appointment });
  }

  const client = new OpenAI({ apiKey: env.openaiApiKey });

  try {
    const completion = await client.chat.completions.create({
      model: env.openaiModel,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'Eres asistente de una clinica odontologica. Redacta un mensaje breve (maximo 350 caracteres), profesional y calido en espanol, listo para WhatsApp. Si la urgencia es high o critical y hay turno asignado, confirma directamente ese turno. No inventes precios ni horarios.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            patientName: name || '',
            incomingMessage: message || '',
            analysis,
            appointment: appointment || null
          })
        }
      ]
    });

    const text = completion.choices[0] && completion.choices[0].message ? completion.choices[0].message.content : '';
    if (!text || !text.trim()) {
      return templateReply({ name, analysis, appointment });
    }

    return text.trim();
  } catch (error) {
    return templateReply({ name, analysis, appointment });
  }
}

module.exports = { generateReply };

