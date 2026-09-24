// Independently transcribed from P1/P2-FROZEN-1 §3.2, not from v4 implementation arrays.
export const tables = {
  im_center_epochs: 'center_epoch created_at origin recovery_counter',
  im_center_state: 'singleton center_epoch recovery_counter status activation_ref recovery_run_id updated_at',
  im_schema_preparations: 'preparation_ref kind input_hash source_version source_schema_checksum import_epoch initial_epoch policy_hash created_at',
  im_recovery_runs: 'run_id candidate_kind preparation_ref backup_id backup_file_hash manifest_hash candidate_base_hash candidate_reference old_epoch new_epoch approved_plan_hash approval_ref isolation_ack_ref rpo_report_json auth_review_ref activation_plan_hash activation_approval_ref status created_at verified_at activated_at activation_ref failure_code',
  im_retention_policies: 'policy_hash version effective_at message_retention_ms attachment_retention_ms safe_retry_window_ms audit_retention_ms canonical_json',
  im_content_state: 'message_id state expires_at expired_at scrubbed_at policy_hash expiry_run_id scrub_run_id',
  im_attachment_reservations: 'attachment_id message_id size sha256',
  im_send_operation_keys: 'sender_id origin_epoch client_message_id storage_client_message_id source_protocol message_id',
  im_sync_progress: 'recipient_id center_epoch stream_epoch handled_through updated_at',
  im_expiry_receipts: 'recipient_id center_epoch stream_epoch seq message_id recorded_at',
  im_maintenance_runs: 'run_id center_epoch kind execution_policy_hash plan_hash approved_batch_hash approval_ref executor_id status candidate_json result_json previewed_at expires_at completed_at scan_rows scan_bytes changed_rows changed_bytes',
};
export const indexes = {
  im_content_expiry: ['im_content_state', 'state,expires_at,message_id'],
  im_content_scrub: ['im_content_state', 'state,scrubbed_at,expires_at,message_id'],
  im_content_policy: ['im_content_state', 'policy_hash,message_id'],
  im_content_expiry_run: ['im_content_state', 'expiry_run_id'],
  im_content_scrub_run: ['im_content_state', 'scrub_run_id'],
  im_maintenance_completed: ['im_maintenance_runs', 'status,completed_at,run_id'],
  im_maintenance_policy: ['im_maintenance_runs', 'execution_policy_hash,run_id'],
  im_maintenance_epoch: ['im_maintenance_runs', 'center_epoch,run_id'],
  im_recovery_backup: ['im_recovery_runs', 'backup_id,run_id'],
  im_recovery_old_epoch: ['im_recovery_runs', 'old_epoch,run_id'],
  im_recovery_preparation: ['im_recovery_runs', 'preparation_ref,run_id'],
  im_preparation_import_epoch: ['im_schema_preparations', 'import_epoch,preparation_ref'],
  im_preparation_policy: ['im_schema_preparations', 'policy_hash,preparation_ref'],
  im_center_recovery: ['im_center_state', 'recovery_run_id'],
  im_operation_epoch: ['im_send_operation_keys', 'origin_epoch,sender_id,client_message_id'],
  im_sync_epoch: ['im_sync_progress', 'center_epoch,recipient_id,stream_epoch'],
  im_expiry_delivery: ['im_expiry_receipts', 'recipient_id,seq'],
  im_expiry_message: ['im_expiry_receipts', 'message_id'],
};
// Foreign-key tuples: local columns -> referenced table(columns), including composite bindings.
export const foreignKeys = {
  im_center_epochs: [],
  im_center_state: ['center_epoch->im_center_epochs(center_epoch)', 'recovery_run_id->im_recovery_runs(run_id)'],
  im_schema_preparations: ['import_epoch->im_center_epochs(center_epoch)', 'initial_epoch->im_center_epochs(center_epoch)', 'policy_hash->im_retention_policies(policy_hash)'],
  im_recovery_runs: ['preparation_ref->im_schema_preparations(preparation_ref)', 'old_epoch->im_center_epochs(center_epoch)', 'new_epoch->im_center_epochs(center_epoch)'],
  im_retention_policies: [],
  im_content_state: ['message_id->im_messages(message_id)', 'policy_hash->im_retention_policies(policy_hash)', 'expiry_run_id->im_maintenance_runs(run_id)', 'scrub_run_id->im_maintenance_runs(run_id)'],
  im_attachment_reservations: ['message_id->im_messages(message_id)'],
  im_send_operation_keys: ['sender_id->im_agents(agent_id)', 'origin_epoch->im_center_epochs(center_epoch)', 'message_id->im_messages(message_id)', 'sender_id,storage_client_message_id->im_send_keys(sender_id,client_message_id)'],
  im_sync_progress: ['recipient_id->im_receive_state(agent_id)', 'center_epoch->im_center_epochs(center_epoch)'],
  im_expiry_receipts: ['message_id->im_messages(message_id)', 'recipient_id,center_epoch,stream_epoch->im_sync_progress(recipient_id,center_epoch,stream_epoch)', 'recipient_id,seq->im_deliveries(recipient_id,seq)'],
  im_maintenance_runs: ['center_epoch->im_center_epochs(center_epoch)', 'execution_policy_hash->im_retention_policies(policy_hash)'],
};
export const nullable = {
  im_center_epochs: [], im_center_state: ['activation_ref', 'recovery_run_id'],
  im_schema_preparations: ['source_version', 'source_schema_checksum', 'import_epoch'],
  im_recovery_runs: ['preparation_ref', 'backup_id', 'backup_file_hash', 'manifest_hash', 'candidate_base_hash', 'old_epoch',
    'isolation_ack_ref', 'rpo_report_json', 'auth_review_ref', 'activation_plan_hash', 'activation_approval_ref',
    'verified_at', 'activated_at', 'activation_ref', 'failure_code'],
  im_retention_policies: [], im_content_state: ['expired_at', 'scrubbed_at', 'expiry_run_id', 'scrub_run_id'],
  im_attachment_reservations: [], im_send_operation_keys: [], im_sync_progress: [], im_expiry_receipts: [],
  im_maintenance_runs: ['approved_batch_hash', 'approval_ref', 'completed_at'],
};
export const primaryKeys = {
  im_center_epochs: 'center_epoch', im_center_state: 'singleton', im_schema_preparations: 'preparation_ref',
  im_recovery_runs: 'run_id', im_retention_policies: 'policy_hash', im_content_state: 'message_id',
  im_attachment_reservations: 'attachment_id', im_send_operation_keys: 'sender_id,origin_epoch,client_message_id',
  im_sync_progress: 'recipient_id,center_epoch,stream_epoch',
  im_expiry_receipts: 'recipient_id,center_epoch,stream_epoch,seq', im_maintenance_runs: 'run_id',
};
export const uniqueKeys = {
  im_center_epochs: [], im_center_state: ['center_epoch'], im_schema_preparations: ['initial_epoch'],
  im_recovery_runs: ['new_epoch'], im_retention_policies: [], im_content_state: [],
  im_attachment_reservations: ['message_id'], im_send_operation_keys: ['message_id', 'sender_id,storage_client_message_id'],
  im_sync_progress: [], im_expiry_receipts: ['recipient_id,center_epoch,stream_epoch,message_id'], im_maintenance_runs: ['plan_hash'],
};
