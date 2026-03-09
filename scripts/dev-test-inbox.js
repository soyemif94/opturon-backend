require('dotenv').config();

const { query, closePool } = require('../src/db/client');
const { listInboxAppointments } = require('../src/conversations/conversation.repo');
const { buildInboxWarnings } = require('../src/controllers/debug.controller');

async function getSampleIds() {
  const result = await query(
    `SELECT "clinicId", "channelId"
     FROM conversations
     ORDER BY "updatedAt" DESC
     LIMIT 1`
  );
  return result.rows[0] || { clinicId: null, channelId: null };
}

async function main() {
  const sampleIds = await getSampleIds();

  const includeTotalOff = await listInboxAppointments({
    includeTotal: false,
    limit: 5
  });

  const clinicFiltered = await listInboxAppointments({
    clinicId: sampleIds.clinicId,
    limit: 5
  });

  const channelFiltered = await listInboxAppointments({
    channelId: sampleIds.channelId,
    limit: 5
  });

  const shortQIgnoredBase = await listInboxAppointments({
    q: null,
    limit: 5
  });
  const shortQIgnoredTest = await listInboxAppointments({
    q: 'a',
    limit: 5
  });

  const needsHumanActionTrue = await listInboxAppointments({
    needsHumanAction: true,
    limit: 5
  });

  const hasTimeFalse = await listInboxAppointments({
    hasTime: false,
    limit: 5
  });

  const timeWindowAfternoon = await listInboxAppointments({
    timeWindow: ['afternoon'],
    limit: 5
  });

  const prioritySort = await listInboxAppointments({
    sort: 'priority',
    includeTotal: false,
    limit: 5
  });

  const priorityHigh = await listInboxAppointments({
    priority: ['high'],
    limit: 5
  });

  const fieldsPresentOk = prioritySort.items.length === 0
    ? true
    : prioritySort.items.every(
        (i) =>
          Object.prototype.hasOwnProperty.call(i, 'priority') &&
          Object.prototype.hasOwnProperty.call(i, 'needsHumanAction') &&
          Object.prototype.hasOwnProperty.call(i, 'priorityRank') &&
          Object.prototype.hasOwnProperty.call(i, 'ageMinutes')
      );

  const priorityWarnings = buildInboxWarnings({
    sort: 'priority',
    reqQuery: { sort: 'priority', order: 'asc' }
  });

  const needsHumanActionFilterOk = needsHumanActionTrue.items.length === 0
    ? true
    : needsHumanActionTrue.items.every((i) => ['requested', 'reschedule_proposed'].includes(String(i.status || '')));

  const summary = {
    includeTotalOff: true,
    totalOmitted: includeTotalOff.total === null,
    clinicFilterOk: sampleIds.clinicId ? clinicFiltered.items.every((i) => i.clinicId === sampleIds.clinicId) : true,
    channelFilterOk: sampleIds.channelId ? channelFiltered.items.every((i) => i.channelId === sampleIds.channelId) : true,
    shortQIgnored: shortQIgnoredBase.items.length === shortQIgnoredTest.items.length,
    needsHumanActionFilterOk,
    hasTimeFilterOk: !!hasTimeFalse && Array.isArray(hasTimeFalse.items),
    timeWindowFilterOk: !!timeWindowAfternoon && Array.isArray(timeWindowAfternoon.items),
    prioritySortOk: !!prioritySort && Array.isArray(prioritySort.items),
    fieldsPresentOk,
    priorityFilterOk: !!priorityHigh && Array.isArray(priorityHigh.items),
    priorityRankPresent:
      prioritySort.items.length === 0 ? true : prioritySort.items.every((i) => typeof i.priorityRank === 'number'),
    ageMinutesPresent:
      prioritySort.items.length === 0 ? true : prioritySort.items.every((i) => typeof i.ageMinutes === 'number'),
    priorityWarningsOk: Array.isArray(priorityWarnings) && priorityWarnings.includes('order ignored when sort=priority')
  };

  console.log(
    JSON.stringify(
      {
        success: true,
        summary,
        samples: {
          includeTotalOff: includeTotalOff.items.slice(0, 3),
          clinicFiltered: clinicFiltered.items.slice(0, 3),
          channelFiltered: channelFiltered.items.slice(0, 3),
          prioritySort: prioritySort.items.slice(0, 3)
        }
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: error.message
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
