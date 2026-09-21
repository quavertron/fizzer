// Temporary rollout gate. Desktop builds can ship the new runner/helpers while
// production stays on the compatible backend. Never infer installation from CI.
const blocked = () => {
  console.error('Backend activation blocked: record reviewed migration evidence for this exact revision in the production DELEGATION_ACTIVATION variable. See docs/external-agent-access.md.');
  process.exit(1);
};

let record;
try { record = JSON.parse(process.env.DELEGATION_ACTIVATION || ''); }
catch { blocked(); }

if (!record || !/^[0-9a-f]{40}$/.test(process.env.REVISION || '') ||
    record.revision !== process.env.REVISION ||
    record.desktopRunners !== 'verified' ||
    record.existingGenericProcesses !== 'drained' ||
    record.externalClients !== 'verified' ||
    typeof record.evidence !== 'string' || !/^https:\/\/\S+$/.test(record.evidence)) blocked();

console.log(`Delegation migration attested for ${record.revision}; evidence: ${record.evidence}`);
