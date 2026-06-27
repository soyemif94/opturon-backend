const { createHash, randomUUID } = require('crypto');
const { withTransaction } = require('../db/client');
const {
  findPartnerById,
  findPartnerByEmail,
  findPartnerByPhone,
  findStaffUserByEmail,
  createPartnerAccount,
  createPartnerProfile,
  createPartnerRelationship,
  createPartnerAuditLog
} = require('../repositories/partners.repository');
const {
  createPartnerInvitation,
  revokePendingPartnerInvitationsByEmail,
  revokePendingPartnerInvitationsByPartnerId
} = require('../repositories/partner-invitations.repository');
const {
  createRecruitmentApplication,
  updateRecruitmentApplication,
  transitionRecruitmentApplication,
  markRecruitmentApplicationInvitationSent,
  markRecruitmentApplicationAccepted,
  markRecruitmentApplicationExpired,
  findRecruitmentApplicationById,
  findRecruitmentApplicationByIdForUpdate,
  findRecruitmentApplicationByInvitationId,
  listRecruitmentApplications,
  findRecruitmentApplicationDuplicates
} = require('../repositories/partner-recruitment-applications.repository');
const {
  buildPartnerInvitationAcceptLink,
  sendPartnerInvitationEmail
} = require('./partner-invitations-email.service');

const EDITABLE_STATUSES = new Set(['draft', 'changes_requested']);
const PARTNER_CANCEL_STATUSES = new Set(['draft', 'pending_review', 'changes_requested']);
const ACTIVE_APPLICATION_STATUSES = new Set(['pending_review', 'changes_requested', 'approved', 'invitation_sent']);
const TERMINAL_APPLICATION_STATUSES = new Set(['rejected', 'cancelled', 'invitation_accepted', 'expired']);
const TRANSITIONS = new Map([
  ['draft', new Set(['pending_review', 'cancelled'])],
  ['pending_review', new Set(['changes_requested', 'approved', 'rejected', 'cancelled'])],
  ['changes_requested', new Set(['pending_review', 'cancelled'])],
  ['approved', new Set(['invitation_sent', 'rejected'])],
  ['invitation_sent', new Set(['invitation_accepted', 'expired'])]
]);
const ADMIN_REVIEW_AUDIT_ACTIONS = {
  approved: 'partner_recruitment_application_approved',
  rejected: 'partner_recruitment_application_rejected',
  changes_requested: 'partner_recruitment_application_changes_requested'
};
const RECRUITMENT_INVITATION_SOURCE = 'partner_recruitment_application';
const PARTNER_INVITATION_EXPIRES_IN_HOURS = 168;

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function normalizePhone(value) {
  return normalizeString(value).replace(/[^\d]+/g, '');
}

function normalizeDocumentId(value) {
  return normalizeString(value).replace(/[^\da-zA-Z]+/g, '').toUpperCase() || null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizeString(value));
}

function canTransition(from, to) {
  return Boolean(TRANSITIONS.get(from) && TRANSITIONS.get(from).has(to));
}

function hashInvitationToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function buildInvitationExpiryDate() {
  return new Date(Date.now() + PARTNER_INVITATION_EXPIRES_IN_HOURS * 60 * 60 * 1000);
}

function buildApplicationFullName(application) {
  return [application.firstName, application.lastName].filter(Boolean).join(' ').trim();
}

function buildPartnerCode(displayName, email) {
  const normalizedName = String(displayName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const emailLocal = normalizeEmail(email).split('@')[0] || 'asesor';
  const base = normalizedName || emailLocal || 'asesor';
  return `ptn_${base}`;
}

function normalizeDateTime(value, endOfDay = false) {
  const raw = normalizeString(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function logRecruitmentFailure(stage, trace = {}, sponsorPartnerId, error) {
  console.error('partner_recruitment_application_create_failed', {
    event: 'partner_recruitment_application_create_failed',
    traceId: trace.traceId || null,
    requestPath: trace.requestPath || null,
    sponsorPartnerId: sponsorPartnerId || null,
    stage,
    errorCode: error && error.code ? error.code : error && error.name ? error.name : 'unexpected_error',
    postgresCode: error && error.code ? error.code : null,
    constraint: error && error.constraint ? error.constraint : null,
    table: error && error.table ? error.table : null,
    column: error && error.column ? error.column : null,
    detail: error && error.detail ? error.detail : null,
    message: error && error.message ? error.message : 'Unexpected recruitment application failure',
    stack: error && error.stack ? error.stack : null
  });
}

function normalizePayload(payload = {}) {
  const firstName = normalizeString(payload.firstName);
  const lastName = normalizeString(payload.lastName);
  const email = normalizeEmail(payload.email);
  const phone = normalizeString(payload.phone);
  const normalizedPhone = normalizePhone(phone);
  const country = normalizeString(payload.country) || 'Argentina';
  const consentConfirmed = payload.consentConfirmed === true || payload.consentConfirmed === 'true';

  if (!firstName) return { ok: false, reason: 'missing_recruitment_first_name' };
  if (!lastName) return { ok: false, reason: 'missing_recruitment_last_name' };
  if (!email || !email.includes('@')) return { ok: false, reason: 'invalid_recruitment_email' };
  if (!phone || normalizedPhone.length < 6) return { ok: false, reason: 'invalid_recruitment_phone' };
  if (!consentConfirmed) return { ok: false, reason: 'recruitment_consent_required' };

  return {
    ok: true,
    data: {
      firstName,
      lastName,
      email,
      normalizedEmail: email,
      phone,
      normalizedPhone,
      documentId: normalizeString(payload.documentId) || null,
      normalizedDocumentId: normalizeDocumentId(payload.documentId),
      city: normalizeString(payload.city) || null,
      province: normalizeString(payload.province) || null,
      country,
      notes: normalizeString(payload.notes) || null,
      consentConfirmed
    }
  };
}

async function appendRecruitmentAuditLog(input, client = null) {
  return createPartnerAuditLog({
    partnerId: input.partnerId,
    entityType: 'partner_recruitment_application',
    entityId: input.applicationId,
    action: input.action,
    reason: input.reason || null,
    actorType: input.actorType,
    actorStaffUserId: input.actorStaffUserId || null,
    actorPartnerId: input.actorPartnerId || null,
    metadata: {
      previousStatus: input.previousStatus || null,
      nextStatus: input.nextStatus || null,
      invitationId: input.invitationId || null,
      createdPartnerId: input.createdPartnerId || null,
      duplicateWarnings: input.duplicateWarnings || []
    }
  }, client);
}

async function assertSponsorPartner(partnerId, client = null, trace = {}) {
  if (!isUuid(partnerId)) {
    return { ok: false, reason: 'partner_unauthorized', trace };
  }
  const partner = await findPartnerById(partnerId, client);
  if (!partner) return { ok: false, reason: 'partner_identity_invalid' };
  if (partner.status !== 'active') return { ok: false, reason: 'partner_inactive' };
  return { ok: true, partner };
}

async function buildDuplicateWarnings(application, client = null) {
  let matches;
  let existingPartnerByEmail;
  let existingPartnerByPhone;
  let existingStaffUser;

  if (client) {
    matches = await findRecruitmentApplicationDuplicates({
      normalizedEmail: application.normalizedEmail,
      normalizedPhone: application.normalizedPhone,
      normalizedDocumentId: application.normalizedDocumentId,
      excludeApplicationId: application.id
    }, client);
    existingPartnerByEmail = await findPartnerByEmail(application.normalizedEmail, client);
    existingPartnerByPhone = application.normalizedPhone ? await findPartnerByPhone(application.normalizedPhone, client) : null;
    existingStaffUser = await findStaffUserByEmail(application.normalizedEmail, client);
  } else {
    [matches, existingPartnerByEmail, existingPartnerByPhone, existingStaffUser] = await Promise.all([
      findRecruitmentApplicationDuplicates({
        normalizedEmail: application.normalizedEmail,
        normalizedPhone: application.normalizedPhone,
        normalizedDocumentId: application.normalizedDocumentId,
        excludeApplicationId: application.id
      }, client),
      findPartnerByEmail(application.normalizedEmail, client),
      application.normalizedPhone ? findPartnerByPhone(application.normalizedPhone, client) : null,
      findStaffUserByEmail(application.normalizedEmail, client)
    ]);
  }

  const warnings = [];
  const activeMatches = (matches || []).filter((item) => ACTIVE_APPLICATION_STATUSES.has(String(item.status || '')));

  if (existingPartnerByEmail) warnings.push('Ya existe un asesor con este email.');
  if (existingPartnerByPhone) warnings.push('El telefono coincide con otra cuenta.');
  if (activeMatches.some((item) => normalizeEmail(item.email) === application.normalizedEmail)) {
    warnings.push('Otro asesor ya presento a este postulante.');
  }
  if (activeMatches.some((item) => normalizePhone(item.phone) === application.normalizedPhone)) {
    warnings.push('Ya existe una postulacion activa con este telefono.');
  }
  if (
    application.normalizedDocumentId
    && activeMatches.some((item) => normalizeDocumentId(item.documentId) === application.normalizedDocumentId)
  ) {
    warnings.push('Ya existe una postulacion activa con este documento.');
  }
  if (activeMatches.some((item) => item.status === 'invitation_sent')) {
    warnings.push('Existe una invitacion pendiente para esta persona.');
  }
  if (existingStaffUser) {
    warnings.push('Existe un usuario cliente/Admin con el mismo email.');
  }

  return Array.from(new Set(warnings));
}

async function assertNoBlockingDuplicates(application, client = null) {
  const warnings = await buildDuplicateWarnings(application, client);
  const blockers = [];

  if (warnings.includes('Ya existe un asesor con este email.')) blockers.push('partner_email_already_exists');
  if (warnings.includes('Existe una invitacion pendiente para esta persona.')) blockers.push('partner_invitation_already_pending');
  if (warnings.includes('Otro asesor ya presento a este postulante.')) blockers.push('partner_recruitment_application_already_active');
  if (warnings.includes('Ya existe una postulacion activa con este telefono.')) blockers.push('partner_recruitment_phone_already_active');
  if (warnings.includes('Ya existe una postulacion activa con este documento.')) blockers.push('partner_recruitment_document_already_active');

  if (blockers.length > 0) {
    return { ok: false, reason: blockers[0], duplicateWarnings: warnings };
  }
  return { ok: true, duplicateWarnings: warnings };
}

async function createApplicationForPartner(partnerId, payload, trace = {}) {
  const normalized = normalizePayload(payload);
  if (!normalized.ok) return normalized;

  let stage = 'transaction_begin';
  try {
    return await withTransaction(async (client) => {
      stage = 'assert_sponsor_partner';
      const sponsorResult = await assertSponsorPartner(partnerId, client, trace);
      if (!sponsorResult.ok) return sponsorResult;

      stage = 'create_application';
      const draft = await createRecruitmentApplication({
        sponsorPartnerId: partnerId,
        status: 'draft',
        ...normalized.data
      }, client);

      stage = 'duplicate_check';
      const duplicateCheck = await assertNoBlockingDuplicates(draft, client);

      stage = 'append_audit_log';
      await appendRecruitmentAuditLog({
        partnerId,
        applicationId: draft.id,
        action: 'partner_recruitment_application_created',
        actorType: 'partner',
        actorPartnerId: partnerId,
        nextStatus: draft.status,
        duplicateWarnings: duplicateCheck.duplicateWarnings || []
      }, client);

      if (!duplicateCheck.ok) {
        return {
          ok: false,
          reason: duplicateCheck.reason,
          application: draft,
          duplicateWarnings: duplicateCheck.duplicateWarnings
        };
      }

      return { ok: true, application: draft, duplicateWarnings: duplicateCheck.duplicateWarnings };
    });
  } catch (error) {
    logRecruitmentFailure(stage, trace, partnerId, error);
    throw error;
  }
}

async function listApplicationsForPartner(partnerId, query = {}, trace = {}) {
  const sponsorResult = await assertSponsorPartner(partnerId, null, trace);
  if (!sponsorResult.ok) return sponsorResult;
  const result = await listRecruitmentApplications({
    sponsorPartnerId: partnerId,
    status: normalizeString(query.status) || null,
    page: query.page,
    pageSize: query.pageSize
  });
  return { ok: true, ...result };
}

async function getApplicationForPartner(partnerId, applicationId) {
  const application = await findRecruitmentApplicationById(applicationId);
  if (!application || String(application.sponsorPartnerId) !== String(partnerId)) {
    return { ok: false, reason: 'partner_recruitment_application_not_found' };
  }
  const duplicateWarnings = await buildDuplicateWarnings(application);
  return { ok: true, application, duplicateWarnings };
}

async function updateApplicationForPartner(partnerId, applicationId, payload) {
  return withTransaction(async (client) => {
    const current = await findRecruitmentApplicationById(applicationId, client);
    if (!current || String(current.sponsorPartnerId) !== String(partnerId)) {
      return { ok: false, reason: 'partner_recruitment_application_not_found' };
    }
    if (!EDITABLE_STATUSES.has(current.status)) {
      return { ok: false, reason: 'partner_recruitment_application_not_editable' };
    }
    const normalized = normalizePayload(payload);
    if (!normalized.ok) return normalized;

    const application = await updateRecruitmentApplication(applicationId, normalized.data, client);
    const duplicateCheck = await assertNoBlockingDuplicates(application, client);
    await appendRecruitmentAuditLog({
      partnerId,
      applicationId,
      action: current.status === 'changes_requested'
        ? 'partner_recruitment_application_corrected'
        : 'partner_recruitment_application_edited',
      actorType: 'partner',
      actorPartnerId: partnerId,
      previousStatus: current.status,
      nextStatus: application.status,
      duplicateWarnings: duplicateCheck.duplicateWarnings || []
    }, client);

    if (!duplicateCheck.ok) {
      return {
        ok: false,
        reason: duplicateCheck.reason,
        application,
        duplicateWarnings: duplicateCheck.duplicateWarnings
      };
    }

    return { ok: true, application, duplicateWarnings: duplicateCheck.duplicateWarnings };
  });
}

async function submitApplicationForPartner(partnerId, applicationId) {
  const trace = {
    requestPath: `/api/partners/me/recruitment-applications/${applicationId}/submit`
  };
  let stage = 'transaction_begin';
  try {
    return await withTransaction(async (client) => {
      stage = 'load_application';
      const current = await findRecruitmentApplicationById(applicationId, client);
      if (!current || String(current.sponsorPartnerId) !== String(partnerId)) {
        return { ok: false, reason: 'partner_recruitment_application_not_found' };
      }
      if (!canTransition(current.status, 'pending_review')) {
        return { ok: false, reason: 'invalid_partner_recruitment_transition' };
      }

      stage = 'duplicate_check';
      const duplicateCheck = await assertNoBlockingDuplicates(current, client);
      if (!duplicateCheck.ok) {
        return {
          ok: false,
          reason: duplicateCheck.reason,
          application: current,
          duplicateWarnings: duplicateCheck.duplicateWarnings
        };
      }

      stage = 'transition_application';
      const application = await transitionRecruitmentApplication(applicationId, { status: 'pending_review' }, client);

      stage = 'append_audit_log';
      await appendRecruitmentAuditLog({
        partnerId,
        applicationId,
        action: current.status === 'changes_requested'
          ? 'partner_recruitment_application_resubmitted'
          : 'partner_recruitment_application_submitted',
        actorType: 'partner',
        actorPartnerId: partnerId,
        previousStatus: current.status,
        nextStatus: application.status,
        duplicateWarnings: duplicateCheck.duplicateWarnings
      }, client);
      return { ok: true, application, duplicateWarnings: duplicateCheck.duplicateWarnings };
    });
  } catch (error) {
    logRecruitmentFailure(stage, trace, partnerId, error);
    throw error;
  }
}

async function cancelApplicationForPartner(partnerId, applicationId) {
  return withTransaction(async (client) => {
    const current = await findRecruitmentApplicationById(applicationId, client);
    if (!current || String(current.sponsorPartnerId) !== String(partnerId)) {
      return { ok: false, reason: 'partner_recruitment_application_not_found' };
    }
    if (!PARTNER_CANCEL_STATUSES.has(current.status)) {
      return { ok: false, reason: 'invalid_partner_recruitment_transition' };
    }
    const application = await transitionRecruitmentApplication(applicationId, { status: 'cancelled' }, client);
    await appendRecruitmentAuditLog({
      partnerId,
      applicationId,
      action: 'partner_recruitment_application_cancelled',
      actorType: 'partner',
      actorPartnerId: partnerId,
      previousStatus: current.status,
      nextStatus: application.status
    }, client);
    return { ok: true, application };
  });
}

async function listApplicationsForAdmin(query = {}) {
  const result = await listRecruitmentApplications({
    status: normalizeString(query.status) || null,
    partnerFilter: isUuid(query.sponsorPartnerId) ? query.sponsorPartnerId : null,
    search: normalizeString(query.search) || null,
    from: normalizeDateTime(query.from, false),
    to: normalizeDateTime(query.to, true),
    page: query.page,
    pageSize: query.pageSize
  });
  return { ok: true, ...result };
}

async function getApplicationForAdmin(applicationId) {
  const application = await findRecruitmentApplicationById(applicationId);
  if (!application) return { ok: false, reason: 'partner_recruitment_application_not_found' };
  const duplicateWarnings = await buildDuplicateWarnings(application);
  return { ok: true, application, duplicateWarnings };
}

async function reviewApplicationAsAdmin(applicationId, action, payload = {}, actorStaffUserId) {
  const actionMap = {
    approve: 'approved',
    reject: 'rejected',
    request_changes: 'changes_requested'
  };
  const nextStatus = actionMap[normalizeString(action)];
  if (!nextStatus) return { ok: false, reason: 'invalid_partner_recruitment_review_action' };

  const adminNotes = normalizeString(payload.adminNotes);
  if ((nextStatus === 'rejected' || nextStatus === 'changes_requested') && !adminNotes) {
    return { ok: false, reason: 'admin_notes_required' };
  }

  return withTransaction(async (client) => {
    const current = await findRecruitmentApplicationById(applicationId, client);
    if (!current) return { ok: false, reason: 'partner_recruitment_application_not_found' };
    if (!canTransition(current.status, nextStatus)) {
      return { ok: false, reason: 'invalid_partner_recruitment_transition' };
    }
    const duplicateCheck = await assertNoBlockingDuplicates(current, client);
    if (nextStatus === 'approved' && !duplicateCheck.ok) {
      return {
        ok: false,
        reason: duplicateCheck.reason,
        application: current,
        duplicateWarnings: duplicateCheck.duplicateWarnings
      };
    }
    const application = await transitionRecruitmentApplication(applicationId, {
      status: nextStatus,
      setAdminNotes: true,
      adminNotes: adminNotes || null,
      reviewedBy: actorStaffUserId
    }, client);
    await appendRecruitmentAuditLog({
      partnerId: current.sponsorPartnerId,
      applicationId,
      action: ADMIN_REVIEW_AUDIT_ACTIONS[nextStatus],
      actorType: 'staff',
      actorStaffUserId,
      reason: adminNotes || null,
      previousStatus: current.status,
      nextStatus,
      duplicateWarnings: duplicateCheck.duplicateWarnings || []
    }, client);
    return { ok: true, application, duplicateWarnings: duplicateCheck.duplicateWarnings || [] };
  });
}

async function issueRecruitmentInvitationEmail(partner, invitationToken, expiresAt, options = {}) {
  const acceptLink = buildPartnerInvitationAcceptLink(invitationToken);
  return sendPartnerInvitationEmail({
    email: partner.email,
    displayName: partner.profile && partner.profile.displayName ? partner.profile.displayName : partner.email,
    code: partner.profile && partner.profile.code ? partner.profile.code : 'Sin codigo',
    sponsorDisplayName: normalizeString(options.sponsorDisplayName) || null,
    acceptLink,
    expiresAt
  });
}

async function sendRecruitmentInvitationAsAdmin(applicationId, actorStaffUserId) {
  const invitationToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const invitationExpiresAt = buildInvitationExpiryDate();

  const created = await withTransaction(async (client) => {
    const application = await findRecruitmentApplicationByIdForUpdate(applicationId, client);
    if (!application) return { error: 'partner_recruitment_application_not_found' };
    if (application.status === 'invitation_sent' && application.invitationId) {
      return { error: 'partner_recruitment_invitation_already_sent' };
    }
    if (application.status !== 'approved') {
      return { error: 'partner_recruitment_application_not_approved' };
    }

    const sponsor = await findPartnerById(application.sponsorPartnerId, client);
    if (!sponsor) return { error: 'partner_not_found' };
    if (sponsor.status !== 'active') return { error: 'partner_sponsor_inactive' };

    const duplicateCheck = await assertNoBlockingDuplicates(application, client);
    if (!duplicateCheck.ok) {
      return { error: duplicateCheck.reason, duplicateWarnings: duplicateCheck.duplicateWarnings };
    }

    let partner = application.createdPartnerId ? await findPartnerById(application.createdPartnerId, client) : null;
    if (!partner) {
      const createdAccount = await createPartnerAccount({
        email: application.email,
        passwordHash: null,
        status: 'invited'
      }, client);
      const displayName = buildApplicationFullName(application);
      const codeBase = buildPartnerCode(displayName, application.email);
      await createPartnerProfile({
        partnerId: createdAccount.id,
        code: `${codeBase}_${createdAccount.id.slice(0, 8)}`,
        displayName,
        legalName: displayName,
        phone: application.phone || null,
        notes: `recruitment_application:${application.id}`,
        metadata: {
          source: RECRUITMENT_INVITATION_SOURCE,
          sourceId: application.id,
          sponsorPartnerId: application.sponsorPartnerId
        }
      }, client);
      partner = await findPartnerById(createdAccount.id, client);
    }

    await revokePendingPartnerInvitationsByEmail(application.email, client);
    await revokePendingPartnerInvitationsByPartnerId(partner.id, client);
      const invitation = await createPartnerInvitation({
        partnerId: partner.id,
        email: application.email,
        tokenHash: hashInvitationToken(invitationToken),
        expiresAt: invitationExpiresAt.toISOString(),
        sourceType: RECRUITMENT_INVITATION_SOURCE,
        sourceId: application.id,
      sponsorPartnerId: application.sponsorPartnerId,
      createdByStaffUserId: actorStaffUserId || null
    }, client);

    const updated = await markRecruitmentApplicationInvitationSent(application.id, {
      invitationId: invitation.id,
      createdPartnerId: partner.id,
      invitedAt: new Date().toISOString(),
      expiresAt: invitation.expiresAt
    }, client);

    await appendRecruitmentAuditLog({
      partnerId: application.sponsorPartnerId,
      applicationId: application.id,
      action: 'partner_recruitment_invitation_sent',
      actorType: 'staff',
      actorStaffUserId,
      previousStatus: application.status,
      nextStatus: updated.status,
      invitationId: invitation.id,
      createdPartnerId: partner.id,
      duplicateWarnings: duplicateCheck.duplicateWarnings || []
    }, client);

    return {
      application: updated,
      partner,
      invitation,
      sponsorDisplayName: sponsor.profile ? sponsor.profile.displayName : null
    };
  });

  if (!created || created.error) {
    return {
      ok: false,
      reason: created && created.error ? created.error : 'partner_recruitment_invitation_send_failed',
      duplicateWarnings: created && created.duplicateWarnings ? created.duplicateWarnings : undefined
    };
  }

  try {
    const delivery = await issueRecruitmentInvitationEmail(created.partner, invitationToken, created.invitation.expiresAt, {
      sponsorDisplayName: created.sponsorDisplayName
    });
    await createPartnerAuditLog({
      partnerId: created.application.sponsorPartnerId,
      entityType: 'partner_invitation',
      entityId: created.invitation.id,
      action: 'partner_invitation_sent',
      reason: 'email',
      actorType: actorStaffUserId ? 'staff' : 'system',
      actorStaffUserId,
      metadata: {
        provider: delivery.provider,
        deliveryId: delivery.id,
        sourceType: RECRUITMENT_INVITATION_SOURCE,
        sourceId: created.application.id,
        expiresAt: created.invitation.expiresAt
      }
    });
  } catch (error) {
    return { ok: false, reason: error && error.code ? error.code : 'partner_invitation_email_failed' };
  }

  return { ok: true, application: created.application };
}

async function acceptRecruitmentInvitation(invitation, client = null) {
  if (!invitation || invitation.sourceType !== RECRUITMENT_INVITATION_SOURCE || !invitation.sourceId) {
    return { ok: true, application: null, relationship: null };
  }

  const application = await findRecruitmentApplicationByIdForUpdate(invitation.sourceId, client);
  if (!application) return { ok: false, reason: 'partner_recruitment_application_not_found' };
  if (!['approved', 'invitation_sent'].includes(application.status)) {
    return { ok: false, reason: 'partner_recruitment_application_not_invitable' };
  }

  const sponsor = await findPartnerById(application.sponsorPartnerId, client);
  if (!sponsor) return { ok: false, reason: 'partner_sponsor_not_found' };
  if (sponsor.status !== 'active') return { ok: false, reason: 'partner_sponsor_inactive' };
  if (String(sponsor.id) === String(invitation.partnerId)) return { ok: false, reason: 'partner_recruitment_self_invitation' };

  const invitedPartner = await findPartnerById(invitation.partnerId, client);
  if (!invitedPartner) return { ok: false, reason: 'partner_not_found' };
  if (invitedPartner.sponsorPartnerId && String(invitedPartner.sponsorPartnerId) !== String(sponsor.id)) {
    return { ok: false, reason: 'partner_relationship_already_exists' };
  }

  let cursor = sponsor;
  while (cursor && cursor.sponsorPartnerId) {
    if (String(cursor.sponsorPartnerId) === String(invitedPartner.id)) {
      return { ok: false, reason: 'partner_hierarchy_cycle_detected' };
    }
    cursor = await findPartnerById(cursor.sponsorPartnerId, client);
  }

  let relationship = null;
  if (!invitedPartner.sponsorPartnerId) {
    relationship = await createPartnerRelationship({
      partnerId: invitedPartner.id,
      sponsorPartnerId: sponsor.id,
      createdByStaffUserId: invitation.createdByStaffUserId || null
    }, client);
  }

  const updated = await markRecruitmentApplicationAccepted(application.id, {
    createdPartnerId: invitedPartner.id,
    acceptedAt: new Date().toISOString()
  }, client);

  await appendRecruitmentAuditLog({
    partnerId: sponsor.id,
    applicationId: application.id,
    action: 'partner_recruitment_invitation_accepted',
    actorType: 'partner',
    actorPartnerId: invitedPartner.id,
    previousStatus: application.status,
    nextStatus: updated.status,
    invitationId: invitation.id,
    createdPartnerId: invitedPartner.id
  }, client);

  await createPartnerAuditLog({
    partnerId: invitedPartner.id,
    entityType: 'partner_relationship',
    entityId: relationship ? relationship.id : `${sponsor.id}:${invitedPartner.id}`,
    action: 'partner_relationship_created_from_recruitment',
    reason: RECRUITMENT_INVITATION_SOURCE,
    actorType: 'partner',
    actorPartnerId: invitedPartner.id,
    metadata: {
      sponsorPartnerId: sponsor.id,
      applicationId: application.id,
      invitationId: invitation.id,
      depth: 1
    }
  }, client);

  return { ok: true, application: updated, relationship };
}

module.exports = {
  createApplicationForPartner,
  listApplicationsForPartner,
  getApplicationForPartner,
  updateApplicationForPartner,
  submitApplicationForPartner,
  cancelApplicationForPartner,
  listApplicationsForAdmin,
  getApplicationForAdmin,
  reviewApplicationAsAdmin,
  sendRecruitmentInvitationAsAdmin,
  acceptRecruitmentInvitation,
  findRecruitmentApplicationByInvitationId,
  markRecruitmentApplicationExpired,
  normalizePayload,
  canTransition
};
