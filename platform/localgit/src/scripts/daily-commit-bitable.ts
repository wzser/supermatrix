export type DailyCommitBitableResult = {
  name: string;
  committed: boolean;
  message: string;
  filesChanged: number;
  skippedReason: string;
  autoFixed?: boolean;
};

export function buildDailyCommitBitableRecord(date: string, result: DailyCommitBitableResult): Record<string, string> {
  return {
    date,
    repo_name: result.name,
    committed: result.committed ? "yes" : "no",
    commit_message: result.message,
    files_changed: String(result.filesChanged),
    skipped_reason: result.skippedReason,
  };
}

export type BitableRecordReadback = { recordId: string; fields: Record<string, unknown> };

export function parseBitableRecordListResponse(response: unknown, date: string, repoName: string): BitableRecordReadback | undefined {
  if (!response || typeof response !== "object") {
    throw new Error("native lark-cli record-list returned a malformed response");
  }
  const body = response as { ok?: unknown; data?: { fields?: unknown; data?: unknown; record_id_list?: unknown } };
  const data = body.data;
  if (
    body.ok !== true
    || !data
    || !Array.isArray(data.fields)
    || !Array.isArray(data.data)
    || !Array.isArray(data.record_id_list)
    || !data.fields.every((field): field is string => typeof field === "string")
    || !data.record_id_list.every((id): id is string => typeof id === "string" && id.length > 0)
    || !data.data.every((row): row is unknown[] => Array.isArray(row))
    || data.data.length !== data.record_id_list.length
  ) {
    throw new Error("native lark-cli record-list returned no verified record list");
  }
  const fields = data.fields;
  const recordIds = data.record_id_list;
  if (recordIds.length > 1) {
    throw new Error(`Bitable mirror key is ambiguous: ${date}/${repoName} matched ${recordIds.length} records`);
  }
  if (recordIds.length === 0) return undefined;
  const row = data.data[0];
  if (fields.length !== 6 || row.length !== fields.length) {
    throw new Error("native lark-cli record-list readback omitted mirror fields");
  }
  return {
    recordId: recordIds[0],
    fields: Object.fromEntries(fields.map((field, index) => [field, row[index]])),
  };
}
