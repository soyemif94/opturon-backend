const assert = require('assert');
const path = require('path');

function stubModule(relativePath, exportsValue) {
  const resolved = path.resolve(__dirname, '..', '..', relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue
  };
}

const clinics = {
  'clinic-a': {
    id: 'clinic-a',
    name: 'Tenant A',
    botMode: 'automatic',
    botSettings: {
      mode: 'automatic',
      config: null
    }
  },
  'clinic-b': {
    id: 'clinic-b',
    name: 'Tenant B',
    botMode: 'automatic',
    botSettings: {
      mode: 'automatic',
      config: {
        name: 'Boti',
        greetingMessage: 'Hola desde B.',
        tone: 'amigable',
        treatment: 'vos',
        outOfHoursMessage: '',
        fallbackMessage: '',
        handoffMessage: '',
        businessProfilePreset: 'services',
        commercialObjective: 'quote',
        salesMode: 'consultative',
        businessInstructions: 'Explica los servicios reales y facilita una cotizacion.'
      }
    }
  }
};

stubModule('src/services/portal-context.service.js', {
  resolvePortalTenantContext: async (tenantId) => {
    const clinicId = tenantId === 'tenant-a' ? 'clinic-a' : tenantId === 'tenant-b' ? 'clinic-b' : null;
    if (!clinicId) {
      return { ok: false, reason: 'tenant_mapping_not_found' };
    }
    return {
      ok: true,
      tenantId,
      clinic: {
        id: clinicId
      }
    };
  }
});

stubModule('src/repositories/tenant.repository.js', {
  getClinicBotSettingsById: async (clinicId) => clinics[clinicId] || null,
  updateClinicBotModeById: async (clinicId, mode) => {
    clinics[clinicId].botMode = mode;
    clinics[clinicId].botSettings = { ...(clinics[clinicId].botSettings || {}), mode };
    return clinics[clinicId];
  },
  updateClinicBotConfigById: async (clinicId, botConfig) => {
    clinics[clinicId].botSettings = {
      ...(clinics[clinicId].botSettings || {}),
      config: { ...(botConfig || {}) }
    };
    return clinics[clinicId];
  },
  updateClinicBotTransferConfigById: async (clinicId, transferConfig) => {
    clinics[clinicId].botSettings = {
      ...(clinics[clinicId].botSettings || {}),
      transferConfig: { ...(transferConfig || {}) }
    };
    return clinics[clinicId];
  }
});

const {
  getPortalBotSettings,
  updatePortalBotSettings
} = require('../../src/services/portal-bot-settings.service');

async function run() {
  const defaultSettings = await getPortalBotSettings('tenant-a');
  assert.strictEqual(defaultSettings.ok, true);
  assert.strictEqual(defaultSettings.settings.botConfig.greetingMessage, '');
  assert.strictEqual(defaultSettings.settings.botConfig.tone, 'amigable');
  assert.strictEqual(defaultSettings.settings.botConfig.treatment, 'vos');
  assert.strictEqual(defaultSettings.settings.botConfig.businessProfilePreset, null);
  assert.strictEqual(defaultSettings.settings.botConfig.commercialObjective, null);
  assert.strictEqual(defaultSettings.settings.botConfig.salesMode, null);
  assert.strictEqual(defaultSettings.settings.botConfig.businessInstructions, '');

  const updated = await updatePortalBotSettings('tenant-a', {
    botConfig: {
      name: 'Alma',
      greetingMessage: 'Hola, soy Alma.',
      tone: 'profesional',
      treatment: 'usted',
      outOfHoursMessage: 'Fuera de horario.',
      fallbackMessage: 'Fallback A.',
      handoffMessage: 'Handoff A.',
      businessProfilePreset: 'wholesale_distributor',
      commercialObjective: 'order_generation',
      salesMode: 'proactive',
      businessInstructions: 'Ofrece solamente productos disponibles en el catalogo real.'
    }
  });
  assert.strictEqual(updated.ok, true);
  assert.strictEqual(updated.settings.botConfig.name, 'Alma');
  assert.strictEqual(updated.settings.botConfig.handoffMessage, 'Handoff A.');
  assert.strictEqual(updated.settings.botConfig.businessProfilePreset, 'wholesale_distributor');
  assert.strictEqual(updated.settings.botConfig.commercialObjective, 'order_generation');
  assert.strictEqual(updated.settings.botConfig.salesMode, 'proactive');
  assert.strictEqual(updated.settings.botConfig.businessInstructions, 'Ofrece solamente productos disponibles en el catalogo real.');

  const untouchedTenant = await getPortalBotSettings('tenant-b');
  assert.strictEqual(untouchedTenant.ok, true);
  assert.strictEqual(untouchedTenant.settings.botConfig.name, 'Boti');
  assert.strictEqual(untouchedTenant.settings.botConfig.greetingMessage, 'Hola desde B.');
  assert.strictEqual(untouchedTenant.settings.botConfig.businessProfilePreset, 'services');
  assert.strictEqual(untouchedTenant.settings.botConfig.businessInstructions, 'Explica los servicios reales y facilita una cotizacion.');
  assert.notStrictEqual(untouchedTenant.settings.botConfig.name, updated.settings.botConfig.name);

  const invalidEnum = await updatePortalBotSettings('tenant-a', {
    botConfig: { salesMode: 'aggressive' }
  });
  assert.strictEqual(invalidEnum.ok, false);
  assert.strictEqual(invalidEnum.reason, 'invalid_bot_config');
  assert.ok(invalidEnum.fieldErrors.salesMode);

  const tooLong = await updatePortalBotSettings('tenant-a', {
    botConfig: { businessInstructions: 'x'.repeat(4001) }
  });
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(tooLong.reason, 'invalid_bot_config');
  assert.ok(tooLong.fieldErrors.businessInstructions);

  const missingTenant = await updatePortalBotSettings('tenant-does-not-exist', {
    botConfig: { businessInstructions: 'No debe persistir.' }
  });
  assert.strictEqual(missingTenant.ok, false);
  assert.strictEqual(clinics['clinic-b'].botSettings.config.businessInstructions, 'Explica los servicios reales y facilita una cotizacion.');

  console.log('PORTAL.BOT.SETTINGS validation passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
