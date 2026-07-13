'use strict';

function parsePositiveInteger(value, label) {
  var parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Invalid ' + label + ': ' + value);
  }
  return parsed;
}

exports.up = async function(db) {
  var mainStageWaveId = process.env.MAIN_STAGE_WAVE_ID;
  if (!mainStageWaveId) {
    return;
  }
  var anchors = await db.runSql(
    `select wd.drop_id, mc.claim_id
     from wave_decision_winner_drops wd
     join minting_claims mc on mc.drop_id = wd.drop_id
     where wd.wave_id = ?
     order by wd.decision_time asc, wd.ranking asc, wd.drop_id asc`,
    [mainStageWaveId]
  );
  if (!anchors.length) {
    return;
  }
  var winners = await db.runSql(
    `select drop_id, decision_time, ranking, meme_card_id
     from wave_decision_winner_drops
     where wave_id = ?
     order by decision_time asc, ranking asc, drop_id asc`,
    [mainStageWaveId]
  );
  if (!winners.length) {
    throw new Error('No Main Stage winners found for backfill');
  }

  var seenDecisionTimes = new Set();
  var winnerIndexes = new Map();
  winners.forEach(function(winner, index) {
    if (Number(winner.ranking) !== 1) {
      throw new Error('Main Stage backfill requires exactly one rank-1 winner per decision');
    }
    var decisionTime = String(winner.decision_time);
    if (seenDecisionTimes.has(decisionTime)) {
      throw new Error('Multiple Main Stage winners found for decision ' + decisionTime);
    }
    seenDecisionTimes.add(decisionTime);
    winnerIndexes.set(winner.drop_id, index);
  });

  var offsets = new Set();
  var claimIdsByDrop = new Map();
  anchors.forEach(function(anchor) {
    var winnerIndex = winnerIndexes.get(anchor.drop_id);
    if (winnerIndex === undefined) {
      throw new Error('Minting claim anchor is missing its winner: ' + anchor.drop_id);
    }
    var claimId = parsePositiveInteger(anchor.claim_id, 'claim_id');
    var existingClaimId = claimIdsByDrop.get(anchor.drop_id);
    if (existingClaimId !== undefined && existingClaimId !== claimId) {
      throw new Error('Conflicting minting claim anchors for drop ' + anchor.drop_id);
    }
    claimIdsByDrop.set(anchor.drop_id, claimId);
    offsets.add(claimId - winnerIndex);
  });
  if (offsets.size !== 1) {
    throw new Error(
      'Minting claim anchors do not form one sequential Main Stage mapping: ' +
        Array.from(offsets).join(', ')
    );
  }

  var firstMemeCardId = offsets.values().next().value;
  parsePositiveInteger(firstMemeCardId, 'first Meme card ID');
  for (var index = 0; index < winners.length; index += 1) {
    var winner = winners[index];
    var memeCardId = firstMemeCardId + index;
    parsePositiveInteger(memeCardId, 'Meme card ID');
    if (
      winner.meme_card_id !== null &&
      winner.meme_card_id !== undefined &&
      Number(winner.meme_card_id) !== memeCardId
    ) {
      throw new Error('Existing Meme card mapping conflicts for drop ' + winner.drop_id);
    }
    await db.runSql(
      `update wave_decision_winner_drops
       set meme_card_id = ?
       where wave_id = ? and drop_id = ?`,
      [memeCardId, mainStageWaveId, winner.drop_id]
    );
  }
};

exports.down = function() {
  // Intentionally irreversible. Clearing these values would also remove
  // relationships written by claim creation after this migration ran.
};

exports._meta = {
  version: 1
};
