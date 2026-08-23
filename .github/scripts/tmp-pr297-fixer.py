from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

marker = '\nasync function branchHead('
helper = r'''
async function targetFileSnapshots(
  source: Request,
  invoke: Invoke,
  core: CoreInput,
  ref: string,
): Promise<Array<{ path: string; exists: boolean; content: string | null }>> {
  return Promise.all(core.targetPaths.map(async (path) => {
    const { response, payload } = await invokePayload(
      source,
      invoke,
      READ_PATH,
      { path: `/repos/${repoPath(core.repository)}/contents/${contentPath(path)}?ref=${encodeURIComponent(ref)}` },
      true,
    );
    if (response.status === 404) return { path, exists: false, content: null };
    if (!response.ok || payload.ok !== true) {
      throw new CodeChangeError(
        typeof payload.error === 'string' ? payload.error : 'target_file_read_failed',
        response.status,
        { path },
      );
    }
    const content = decodeContent(payload.data);
    if (content === null) throw new CodeChangeError('target_file_not_decodable', 502, { path });
    if (content.length > MAX_FILE_CONTENT) throw new CodeChangeError('file_content_too_large', 413, { path });
    return { path, exists: true, content };
  }));
}
'''
if marker not in text:
    raise SystemExit('branchHead marker missing')
text = text.replace(marker, helper + marker, 1)

old = '''  const guidance = await targetGuidance(source, invoke, core, progress.branchHead);\n  const investigated = await investigationContext(source, invoke, core, progress.branchHead);'''
new = '''  const [guidance, investigated, targetFiles] = await Promise.all([\n    targetGuidance(source, invoke, core, progress.branchHead),\n    investigationContext(source, invoke, core, progress.branchHead),\n    targetFileSnapshots(source, invoke, core, progress.branchHead),\n  ]);'''
if old not in text:
    raise SystemExit('editingResponse reads missing')
text = text.replace(old, new, 1)

old = '''    agentGuidance: guidance,\n    ...investigated,'''
new = '''    agentGuidance: guidance,\n    targetFiles,\n    ...investigated,'''
if old not in text:
    raise SystemExit('editingResponse body marker missing')
text = text.replace(old, new, 1)

old = '''  const investigated = await investigationContext(source, invoke, core, progress.branchHead);'''
new = '''  const [investigated, targetFiles] = await Promise.all([\n    investigationContext(source, invoke, core, progress.branchHead),\n    targetFileSnapshots(source, invoke, core, progress.branchHead),\n  ]);'''
if old not in text:
    raise SystemExit('initial investigation marker missing')
text = text.replace(old, new, 1)

old = '''      preparation: prepared,\n      ...investigated,'''
new = '''      preparation: prepared,\n      targetFiles,\n      ...investigated,'''
if old not in text:
    raise SystemExit('initial body marker missing')
text = text.replace(old, new, 1)

old_note = "note: 'Submit complete contents only for declared targetPaths. Semantic code choices stay with the model.'"
new_note = "note: 'Use targetFiles as the authoritative full snapshot. Submit complete replacement contents only for declared targetPaths; missing targets are marked exists:false.'"
if text.count(old_note) != 2:
    raise SystemExit(f'expected 2 edit notes, got {text.count(old_note)}')
text = text.replace(old_note, new_note)

path.write_text(text)
