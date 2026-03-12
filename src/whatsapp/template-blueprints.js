const BLUEPRINTS = [
  {
    key: 'bienvenida',
    title: 'Bienvenida',
    description: 'Primer mensaje para confirmar recepcion del contacto y ordenar la conversacion.',
    category: 'UTILITY',
    defaultLanguage: 'es_AR',
    version: 1,
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}. Te damos la bienvenida a {{2}}. En breve un integrante del equipo va a continuar la conversacion.',
        example: {
          body_text: [['Mariana', 'Opturon Demo']]
        }
      }
    ]
  },
  {
    key: 'confirmacion_turno',
    title: 'Confirmacion de turno',
    description: 'Confirma fecha y hora de un turno ya asignado.',
    category: 'UTILITY',
    defaultLanguage: 'es_AR',
    version: 1,
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}. Confirmamos tu turno para el {{2}} a las {{3}}. Si necesitas reprogramarlo, responde a este mensaje.',
        example: {
          body_text: [['Lucia', '15/03/2026', '17:30']]
        }
      }
    ]
  },
  {
    key: 'recordatorio_turno',
    title: 'Recordatorio de turno',
    description: 'Recordatorio previo para reducir ausencias y reprogramaciones de ultimo momento.',
    category: 'UTILITY',
    defaultLanguage: 'es_AR',
    version: 1,
    components: [
      {
        type: 'BODY',
        text: 'Te recordamos tu turno de {{1}} para manana {{2}} a las {{3}}. Si necesitas moverlo, avisanos por este medio.',
        example: {
          body_text: [['odontologia', '16/03/2026', '09:00']]
        }
      }
    ]
  },
  {
    key: 'seguimiento_comercial',
    title: 'Seguimiento comercial',
    description: 'Retoma una conversacion comercial con contexto claro y CTA de respuesta.',
    category: 'MARKETING',
    defaultLanguage: 'es_AR',
    version: 1,
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}. Queriamos retomar tu consulta sobre {{2}}. Si te interesa, te compartimos opciones y disponibilidad por este medio.',
        example: {
          body_text: [['Carlos', 'el servicio premium']]
        }
      }
    ]
  },
  {
    key: 'recuperacion_contacto',
    title: 'Recuperacion de contacto',
    description: 'Reengancha leads o contactos frios con un mensaje simple y reutilizable.',
    category: 'MARKETING',
    defaultLanguage: 'es_AR',
    version: 1,
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}. Quedo pendiente tu consulta sobre {{2}}. Si quieres, retomamos por aca y te ayudamos a avanzar.',
        example: {
          body_text: [['Sofia', 'la propuesta']]
        }
      }
    ]
  }
];

function listTemplateBlueprints() {
  return BLUEPRINTS.map((item) => ({ ...item }));
}

function findTemplateBlueprintByKey(templateKey) {
  const safeKey = String(templateKey || '').trim().toLowerCase();
  return BLUEPRINTS.find((item) => item.key === safeKey) || null;
}

module.exports = {
  listTemplateBlueprints,
  findTemplateBlueprintByKey
};
