// Hand-authored full records in contract §4.2 order. Hashes are checked by the
// standalone offline oracle; it never imports the product codec or writes files.
export const vectors = [
  {
    kind: 'timeProposal',
    canonical: '{"version":1,"instanceId":"11111111-1111-4111-8111-111111111111","instanceCreatedAt":100,"centerEpoch":"22222222-2222-4222-8222-222222222222","previousGeneration":null,"previousAnchorHash":null,"sessionNonce":"33333333-3333-4333-8333-333333333333","proposedAt":1000,"proposalExpiresAt":301000,"candidateWallAt":1000,"acceptNotBefore":1000,"acceptNotAfter":6000,"globalFloorObservedAt":900,"maxForwardJumpMs":86400000}',
    hash: '657f6c791cb6840c6d2f775e049433c746ba595ca525b9112f3294234fbbf1b5',
  },
  {
    kind: 'anchorEvidence',
    canonical: '{"version":1,"instanceId":"11111111-1111-4111-8111-111111111111","instanceCreatedAt":100,"generation":1,"centerEpoch":"22222222-2222-4222-8222-222222222222","previousGeneration":null,"previousAnchorHash":null,"proposalHash":"657f6c791cb6840c6d2f775e049433c746ba595ca525b9112f3294234fbbf1b5","sessionNonce":"33333333-3333-4333-8333-333333333333","proposedAt":1000,"proposalExpiresAt":301000,"candidateWallAt":1000,"acceptNotBefore":1000,"acceptNotAfter":6000,"acceptedWallAt":1500,"globalFloorObservedAt":900,"globalFloorAtApproval":1200,"maxForwardJumpMs":86400000,"approvalRef":"approval/时间-é","executorId":"executor/甲","approverId":"approver/乙"}',
    hash: 'c772f9a0d8d4873f0559fdc8c6b444372d1604906057bfdc0314152a58fb00ed',
  },
  {
    kind: 'conversionPlan',
    canonical: '{"version":1,"transitionId":"44444444-4444-4444-8444-444444444444","instanceId":"11111111-1111-4111-8111-111111111111","instanceCreatedAt":100,"centerEpoch":"22222222-2222-4222-8222-222222222222","recoveryRunId":"55555555-5555-4555-8555-555555555555","stageHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidateReference":"runs/55555555-5555-4555-8555-555555555555/candidate.sqlite","candidateKind":"fresh_bootstrap","preparationRef":"prepare/初期","sourceEvidenceHash":null,"fromVersion":4,"fromChecksum":"4444444444444444444444444444444444444444444444444444444444444444","toVersion":5,"toChecksum":"5555555555555555555555555555555555555555555555555555555555555555","preconversionFileHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","executionPolicyHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","createdAt":2000,"expiresAt":302000}',
    hash: '81e860d558be5ab7a4754012ee213ecb8a58dd031969e9c89ec241950e96dd6a',
  },
  {
    kind: 'conversionProof',
    canonical: '{"version":1,"plan":{"version":1,"transitionId":"44444444-4444-4444-8444-444444444444","instanceId":"11111111-1111-4111-8111-111111111111","instanceCreatedAt":100,"centerEpoch":"22222222-2222-4222-8222-222222222222","recoveryRunId":"55555555-5555-4555-8555-555555555555","stageHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidateReference":"runs/55555555-5555-4555-8555-555555555555/candidate.sqlite","candidateKind":"fresh_bootstrap","preparationRef":"prepare/初期","sourceEvidenceHash":null,"fromVersion":4,"fromChecksum":"4444444444444444444444444444444444444444444444444444444444444444","toVersion":5,"toChecksum":"5555555555555555555555555555555555555555555555555555555555555555","preconversionFileHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","executionPolicyHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","createdAt":2000,"expiresAt":302000},"planHash":"81e860d558be5ab7a4754012ee213ecb8a58dd031969e9c89ec241950e96dd6a","approvalRef":"approval/转换","executorId":"executor/甲","approverId":"approver/乙","convertedAt":2000}',
    hash: 'c1b69d22acdb5d276971fdcddc5b582b6101bfce19ce15c49eff2ec6f93659c2',
  },
  {
    kind: 'conversionComplete',
    canonical: '{"version":1,"transitionId":"44444444-4444-4444-8444-444444444444","planHash":"81e860d558be5ab7a4754012ee213ecb8a58dd031969e9c89ec241950e96dd6a","conversionProofHash":"c1b69d22acdb5d276971fdcddc5b582b6101bfce19ce15c49eff2ec6f93659c2","instanceId":"11111111-1111-4111-8111-111111111111","instanceCreatedAt":100,"centerEpoch":"22222222-2222-4222-8222-222222222222","recoveryRunId":"55555555-5555-4555-8555-555555555555","stageHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidateReference":"runs/55555555-5555-4555-8555-555555555555/candidate.sqlite","schemaVersion":5,"schemaChecksum":"5555555555555555555555555555555555555555555555555555555555555555","preconversionFileHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","postconversionFileHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}',
    hash: '2cc55ef8d31d66e87b620936bf987aa0255dee2f9dd72e746751f5f92b382102',
  },
];
